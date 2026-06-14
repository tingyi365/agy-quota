'use strict';

/**
 * High-level: resolve credential -> refresh -> fetch quota -> normalize.
 * Produces a stable, agent-friendly result object.
 */

const { loadCredential } = require('./credentials');
const { refreshAccessToken, fetchUserQuota, loadCodeAssist, fetchAvailableModels } = require('./api');
const { providerForModel } = require('./run');

/**
 * Group the fetchAvailableModels response into provider buckets.
 *
 * IMPORTANT — empirically verified granularity of `quotaInfo.remainingFraction`
 * (see README "全模型額度池 / All-model quota pool"):
 *   - The value is a REAL, token-weighted consumption meter (it measurably
 *     decreases as you spend), NOT a binary availability flag.
 *   - But it is POOLED, not per-model. Every Gemini model shares one Google
 *     pool; every Anthropic AND OpenAI model shares ONE Vertex pool together
 *     (burning a gpt-oss request decrements Claude's fraction identically).
 *   - So this fraction is the POOL's remaining headroom, not a private
 *     per-model budget. We label it token_type=POOL_FRACTION to be honest.
 *
 * The authoritative per-account Gemini meter remains retrieveUserQuota's
 * REQUESTS buckets (top-level `models[]`), which use a different (daily on
 * paid tiers) window — kept verbatim for backward compatibility.
 */
function buildProviders(modelsEnv) {
  const raw = (modelsEnv && modelsEnv.models) || {};
  const order = ['ANTHROPIC', 'OPENAI', 'GOOGLE', 'UNKNOWN'];
  const scopeFor = (p) =>
    p === 'GOOGLE' ? 'google_pool' : p === 'UNKNOWN' ? 'unknown' : 'vertex_pool_shared';
  const noteFor = (p) =>
    p === 'GOOGLE'
      ? 'All Gemini models share ONE Google quota pool (token-weighted, short rolling window). ' +
        'The authoritative per-account Gemini REQUESTS meter is in top-level models[] (retrieveUserQuota).'
      : p === 'UNKNOWN'
      ? 'Provider could not be classified from the model id.'
      : 'Anthropic and OpenAI models share ONE Vertex quota pool together — consuming any model ' +
        'in this pool decrements every model in it equally. This is pool headroom, not a per-model budget.';

  const groups = new Map();
  for (const [id, m] of Object.entries(raw)) {
    if (m.isInternal || /^tab[_-]/.test(id)) continue;
    const provider = providerForModel(id).toUpperCase();
    const frac =
      m.quotaInfo && typeof m.quotaInfo.remainingFraction === 'number'
        ? m.quotaInfo.remainingFraction
        : null;
    const reset = (m.quotaInfo && m.quotaInfo.resetTime) || null;
    const row = {
      model_id: id,
      token_type: 'POOL_FRACTION',
      remaining_fraction: frac,
      remaining_percent: frac == null ? null : Math.round(frac * 1000) / 10,
      reset_time: reset,
    };
    if (!groups.has(provider)) groups.set(provider, []);
    groups.get(provider).push(row);
  }

  const providers = [];
  const keys = [...groups.keys()].sort(
    (a, b) => (order.indexOf(a) + 1 || 99) - (order.indexOf(b) + 1 || 99)
  );
  for (const provider of keys) {
    const models = groups.get(provider).sort((a, b) => a.model_id.localeCompare(b.model_id));
    // Pool fraction = the shared value (every model in the group reports the
    // same one); use the min defensively in case the backend ever diverges.
    const fracs = models.map((m) => m.remaining_fraction).filter((x) => x != null);
    const poolFrac = fracs.length ? Math.min(...fracs) : null;
    const resets = models.map((m) => m.reset_time).filter(Boolean).sort();
    providers.push({
      provider,
      quota_scope: scopeFor(provider),
      note: noteFor(provider),
      quota_source: 'fetchAvailableModels',
      pool_remaining_fraction: poolFrac,
      pool_remaining_percent: poolFrac == null ? null : Math.round(poolFrac * 1000) / 10,
      pool_reset_time: resets.length ? resets[0] : null,
      models,
    });
  }
  return providers;
}

/**
 * @returns {Promise<{
 *   account: string|null,
 *   plan: string|null,
 *   current_tier: string|null,
 *   remaining_fraction: number,   // worst (min) across models — the gate value
 *   reset_time: string|null,      // earliest reset across models (ISO)
 *   models: Array<{model_id:string, token_type:string, remaining_fraction:number, remaining_percent:number, reset_time:string}>,
 *   providers: Array<{provider:string, quota_scope:string, note:string, quota_source:string,
 *                     pool_remaining_fraction:number|null, pool_remaining_percent:number|null,
 *                     pool_reset_time:string|null,
 *                     models:Array<{model_id, token_type, remaining_fraction, remaining_percent, reset_time}>}>,
 *   providers_error: string|null,
 *   remaining_fraction_all_pools: number,  // worst across gemini buckets + every provider pool
 *   remaining_percent_all_pools: number,
 *   source: string,
 *   fetched_at: string
 * }>}
 *
 * Legacy fields (`remaining_fraction`, `reset_time`, `models[]`) keep their
 * original gemini-REQUESTS-bucket meaning for backward compatibility; the
 * all-model view is purely additive under `providers[]`.
 */
async function getQuota(opts = {}) {
  const cred = loadCredential();
  const { accessToken } = await refreshAccessToken(cred.refresh_token);

  const quota = await fetchUserQuota(accessToken, opts.host);

  // All-model pool view is best-effort: never fail the (backward-compatible)
  // gemini-bucket call just because the multi-provider listing errored.
  let providers = [];
  let providersError = null;
  try {
    const modelsEnv = await fetchAvailableModels(accessToken, { host: opts.host });
    providers = buildProviders(modelsEnv);
  } catch (e) {
    providersError = e.message;
  }

  // tier/account is best-effort; never fail the whole call if it errors.
  let account = null;
  let plan = null;
  let currentTier = null;
  try {
    const ca = await loadCodeAssist(accessToken, opts.host);
    currentTier = ca.currentTier?.name || ca.currentTier?.id || null;
    plan = ca.paidTier?.name || ca.paidTier?.id || currentTier;
    const m = ca.manageSubscriptionUri && /Email=([^&]+)/.exec(ca.manageSubscriptionUri);
    if (m) account = decodeURIComponent(m[1]);
  } catch (_) {
    /* tier info is optional */
  }

  const buckets = Array.isArray(quota.buckets) ? quota.buckets : [];
  const models = buckets.map((b) => {
    const frac = typeof b.remainingFraction === 'number' ? b.remainingFraction : 1;
    return {
      model_id: b.modelId || 'unknown',
      token_type: b.tokenType || 'REQUESTS',
      remaining_fraction: frac,
      remaining_percent: Math.round(frac * 1000) / 10,
      reset_time: b.resetTime || null,
    };
  });

  const worst = models.length ? Math.min(...models.map((m) => m.remaining_fraction)) : 1;
  const resets = models.map((m) => m.reset_time).filter(Boolean).sort();
  const resetTime = resets.length ? resets[0] : null;

  // Worst across EVERY pool (gemini REQUESTS buckets + every provider pool) —
  // a fuller gate value than the gemini-only `remaining_fraction`. Additive:
  // the legacy field keeps its original (gemini-bucket) meaning.
  const allFracs = [
    ...models.map((m) => m.remaining_fraction),
    ...providers.map((p) => p.pool_remaining_fraction).filter((x) => x != null),
  ];
  const worstAll = allFracs.length ? Math.min(...allFracs) : worst;

  return {
    account,
    plan,
    current_tier: currentTier,
    remaining_fraction: worst,
    reset_time: resetTime,
    models,
    providers,
    providers_error: providersError,
    remaining_fraction_all_pools: worstAll,
    remaining_percent_all_pools: Math.round(worstAll * 1000) / 10,
    source: cred.source,
    fetched_at: new Date().toISOString(),
  };
}

module.exports = { getQuota };
