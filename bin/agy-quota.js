#!/usr/bin/env node
'use strict';

/**
 * agy-quota — query the real Antigravity (Gemini Code Assist) usage quota for
 * the logged-in account, headlessly (no IDE/language-server needed).
 *
 *   agy-quota            pretty colored terminal output
 *   agy-quota --json     clean JSON for agents/scripts
 *   agy-quota --plain    no ANSI colors
 *   agy-quota --gate 15  exit 0 if worst remaining >= 15%, else exit 10
 */

const { getQuota } = require('../src/quota');

function parseArgs(argv) {
  const o = { json: false, plain: false, gate: null, gateScope: 'google', help: false };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json' || a === '-j') o.json = true;
    else if (a === '--plain' || a === '--no-color') o.plain = true;
    else if (a === '--gate') o.gate = parseFloat(argv[++i]);
    else if (a === '--gate-scope') o.gateScope = String(argv[++i] || '').toLowerCase();
    else if (a === '--help' || a === '-h') o.help = true;
  }
  return o;
}

const HELP = `agy-quota — headless Antigravity / Gemini Code Assist quota checker

Usage:
  agy-quota [options]

Options:
  -j, --json            Emit clean JSON (for agents/scripts)
      --plain           Disable ANSI colors
      --gate <pct>      Exit 0 if worst remaining >= <pct>%, else exit 10
      --gate-scope <s>  Gate on 'google' (default, gemini REQUESTS buckets) or
                        'all' (worst across every provider pool)
  -h, --help            Show this help

JSON fields: account, plan, current_tier, remaining_fraction (0-1, gemini
             buckets — worst), reset_time (ISO), models[] (gemini buckets),
             providers[] (ALL models grouped ANTHROPIC/OPENAI/GOOGLE, each with
             model_id/remaining_percent/token_type/reset_time + pooled scope),
             remaining_fraction_all_pools, remaining_percent_all_pools,
             source, fetched_at
Exit codes:  0 ok  ·  1 error  ·  10 gate not met`;

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[90m',
  green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m',
};

function colorFor(frac, plain) {
  if (plain) return '';
  if (frac >= 0.5) return C.green;
  if (frac >= 0.15) return C.yellow;
  return C.red;
}

function bar(frac, width, plain) {
  const filled = Math.round(Math.max(0, Math.min(1, frac)) * width);
  const col = colorFor(frac, plain);
  const on = '█'.repeat(filled);
  const off = '░'.repeat(width - filled);
  return plain ? on + off : `${col}${on}${C.dim}${off}${C.reset}`;
}

function fmtReset(iso, plain) {
  if (!iso) return '—';
  const d = new Date(iso);
  if (isNaN(d.getTime())) return iso;
  const mins = Math.round((d.getTime() - Date.now()) / 60000);
  if (mins <= 0) return 'now';
  const h = Math.floor(mins / 60);
  const m = mins % 60;
  const rel = h > 0 ? `${h}h${m}m` : `${m}m`;
  const local = d.toLocaleString();
  return plain ? `${rel} (${local})` : `${C.dim}↻ ${rel} · ${local}${C.reset}`;
}

function pad(s, n) {
  // visible length, ignoring ANSI
  const visible = s.replace(/\x1b\[[0-9;]*m/g, '');
  return s + ' '.repeat(Math.max(0, n - visible.length));
}

function modelRow(m, nameW, plain, rs) {
  const frac = m.remaining_fraction == null ? 1 : m.remaining_fraction;
  const col = colorFor(frac, plain);
  const pct = m.remaining_percent == null ? '—' : `${m.remaining_percent.toFixed(1)}%`;
  const pctStr = plain ? pct : `${col}${pct}${rs}`;
  return (
    `  ${pad(m.model_id, nameW)}  ${bar(frac, 20, plain)} ` +
    `${pad(pctStr, plain ? 7 : 16)}  ${fmtReset(m.reset_time, plain)}`
  );
}

function renderPretty(q, plain) {
  const b = plain ? '' : C.bold;
  const cy = plain ? '' : C.cyan;
  const dim = plain ? '' : C.dim;
  const rs = plain ? '' : C.reset;
  const lines = [];
  lines.push('');
  lines.push(`  ${b}Antigravity quota${rs}  ${dim}(${q.source})${rs}`);
  const acct = q.account || 'unknown';
  const plan = q.plan || q.current_tier || 'unknown';
  lines.push(`  ${cy}${acct}${rs}   plan: ${b}${plan}${rs}`);

  // All-model pools, grouped by provider (fetchAvailableModels).
  const providers = Array.isArray(q.providers) ? q.providers : [];
  if (providers.length) {
    const everyName = providers.flatMap((p) => p.models.map((m) => m.model_id));
    const nameW = Math.max(12, ...everyName.map((n) => n.length));
    for (const p of providers) {
      const scope =
        p.quota_scope === 'vertex_pool_shared'
          ? 'shared Vertex pool — one meter for ALL Anthropic+OpenAI models'
          : p.quota_scope === 'google_pool'
          ? 'shared Google pool (token-weighted)'
          : p.quota_scope;
      lines.push('');
      lines.push(`  ${b}${p.provider}${rs}  ${dim}${scope}${rs}`);
      for (const m of p.models) lines.push(modelRow(m, nameW, plain, rs));
    }
  } else if (q.providers_error) {
    lines.push('');
    lines.push(`  ${dim}(all-model pool view unavailable: ${q.providers_error})${rs}`);
  }

  // Authoritative Gemini REQUESTS buckets (retrieveUserQuota), kept verbatim.
  if (q.models.length) {
    const nameW = Math.max(12, ...q.models.map((m) => m.model_id.length));
    lines.push('');
    lines.push(`  ${b}GOOGLE · REQUESTS buckets${rs}  ${dim}retrieveUserQuota · authoritative per-account meter${rs}`);
    for (const m of q.models) lines.push(modelRow(m, nameW, plain, rs));
  }

  lines.push('');
  const wfrac = q.remaining_fraction_all_pools != null ? q.remaining_fraction_all_pools : q.remaining_fraction;
  const wcol = colorFor(wfrac, plain);
  const wpct = `${(wfrac * 100).toFixed(1)}%`;
  lines.push(`  worst remaining (all pools): ${plain ? wpct : wcol + b + wpct + rs}`);
  lines.push(`  ${dim}gemini-bucket worst: ${(q.remaining_fraction * 100).toFixed(1)}%  ·  reset ${fmtReset(q.reset_time, true)}${rs}`);
  lines.push('');
  return lines.join('\n');
}

(async () => {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(HELP + '\n');
    return;
  }
  try {
    const q = await getQuota();
    if (opts.json) {
      process.stdout.write(JSON.stringify(q, null, 2) + '\n');
    } else {
      process.stdout.write(renderPretty(q, opts.plain) + '\n');
    }
    if (opts.gate != null && !isNaN(opts.gate)) {
      const frac =
        opts.gateScope === 'all' && q.remaining_fraction_all_pools != null
          ? q.remaining_fraction_all_pools
          : q.remaining_fraction;
      if (frac * 100 < opts.gate) process.exit(10);
    }
  } catch (e) {
    if (opts.json) {
      process.stdout.write(JSON.stringify({ error: e.message }, null, 2) + '\n');
    } else {
      process.stderr.write(`${C.red}agy-quota error:${C.reset} ${e.message}\n`);
    }
    process.exit(1);
  }
})();
