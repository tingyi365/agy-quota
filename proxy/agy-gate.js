#!/usr/bin/env node
'use strict';

/**
 * agy-gate — the spawn-time guard for routing an AIWF worker through the proxy.
 *
 * Before a worker is launched onto the free Antigravity Opus quota, we MUST
 * check the pool it will actually drain: the shared **Vertex pool** that backs
 * `claude-opus-4-6-thinking` (Anthropic + OpenAI models, resets ~every 5h).
 * If that pool's remaining headroom is below the threshold we say "fallback" so
 * the caller spawns on the paid Anthropic API instead — never blocking work,
 * just declining the free lane when it's nearly empty.
 *
 * Reuses the agy-quota pipeline verbatim (src/quota.js → providers[ANTHROPIC]).
 *
 *   node proxy/agy-gate.js                 # human-ish line + exit code
 *   node proxy/agy-gate.js --json          # JSON decision object
 *   node proxy/agy-gate.js --threshold 20  # default 20 (%), or AGY_GATE_THRESHOLD
 *
 * Exit codes:  0 = go (route via proxy)  ·  10 = fallback (pool too low)
 *              1 = error (cannot determine quota → caller should fall back too)
 */

const { getQuota } = require('../src/quota');

function parseArgs(argv) {
  const o = { json: false, threshold: null };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json' || a === '-j') o.json = true;
    else if (a === '--threshold' || a === '-t') o.threshold = parseFloat(argv[++i]);
    else if (a === '--help' || a === '-h') o.help = true;
  }
  return o;
}

function pickAnthropicPool(q) {
  const providers = Array.isArray(q.providers) ? q.providers : [];
  const anth = providers.find((p) => p.provider === 'ANTHROPIC');
  if (!anth) return null;
  return {
    remaining_percent: anth.pool_remaining_percent,
    remaining_fraction: anth.pool_remaining_fraction,
    reset_time: anth.pool_reset_time,
    quota_scope: anth.quota_scope,
    models: anth.models.map((m) => m.model_id),
  };
}

async function decide(threshold) {
  const q = await getQuota();
  const pool = pickAnthropicPool(q);
  if (!pool || pool.remaining_percent == null) {
    throw new Error(
      'Could not read the Antigravity ANTHROPIC/Vertex pool from quota' +
      (q.providers_error ? ` (providers_error: ${q.providers_error})` : '') + '.'
    );
  }
  const go = pool.remaining_percent >= threshold;
  return {
    ok: go,
    decision: go ? 'go' : 'fallback',
    scope: 'antigravity_vertex_pool',
    pool_model: 'claude-opus-4-6-thinking',
    remaining_percent: pool.remaining_percent,
    threshold,
    reset_time: pool.reset_time,
    account: q.account || null,
    fetched_at: q.fetched_at,
    reason: go
      ? `Vertex pool ${pool.remaining_percent}% >= ${threshold}% → route worker via proxy (free Opus).`
      : `Vertex pool ${pool.remaining_percent}% < ${threshold}% → fall back to paid Anthropic API.`,
  };
}

(async () => {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write('agy-gate — gate a worker on the Antigravity Vertex (Opus) pool.\n' +
      'Usage: node proxy/agy-gate.js [--json] [--threshold <pct>]\n' +
      'Exit: 0 go · 10 fallback · 1 error\n');
    return;
  }
  const threshold =
    opts.threshold != null && !isNaN(opts.threshold)
      ? opts.threshold
      : (parseFloat(process.env.AGY_GATE_THRESHOLD) || 20);

  try {
    const d = await decide(threshold);
    if (opts.json) process.stdout.write(JSON.stringify(d, null, 2) + '\n');
    else process.stdout.write(`[agy-gate] ${d.decision.toUpperCase()} — ${d.reason}\n`);
    process.exit(d.ok ? 0 : 10);
  } catch (e) {
    if (opts.json) process.stdout.write(JSON.stringify({ ok: false, decision: 'fallback', error: e.message }, null, 2) + '\n');
    else process.stderr.write(`[agy-gate] ERROR (caller should fall back to paid API): ${e.message}\n`);
    process.exit(1);
  }
})();

module.exports = { decide, pickAnthropicPool };
