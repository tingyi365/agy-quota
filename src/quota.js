'use strict';

/**
 * High-level: resolve credential -> refresh -> fetch quota -> normalize.
 * Produces a stable, agent-friendly result object.
 */

const { loadCredential } = require('./credentials');
const { refreshAccessToken, fetchUserQuota, loadCodeAssist } = require('./api');

/**
 * @returns {Promise<{
 *   account: string|null,
 *   plan: string|null,
 *   current_tier: string|null,
 *   remaining_fraction: number,   // worst (min) across models — the gate value
 *   reset_time: string|null,      // earliest reset across models (ISO)
 *   models: Array<{model_id:string, token_type:string, remaining_fraction:number, remaining_percent:number, reset_time:string}>,
 *   source: string,
 *   fetched_at: string
 * }>}
 */
async function getQuota(opts = {}) {
  const cred = loadCredential();
  const { accessToken } = await refreshAccessToken(cred.refresh_token);

  const quota = await fetchUserQuota(accessToken, opts.host);

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

  return {
    account,
    plan,
    current_tier: currentTier,
    remaining_fraction: worst,
    reset_time: resetTime,
    models,
    source: cred.source,
    fetched_at: new Date().toISOString(),
  };
}

module.exports = { getQuota };
