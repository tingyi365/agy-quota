#!/usr/bin/env node
'use strict';

/**
 * agy-run — run a prompt on Antigravity (agy) headlessly and print the result.
 *
 * Lets an orchestrator offload work onto the agy free quota via plain HTTPS,
 * with no IDE / language-server / TTY (the agy console binary hangs headless).
 *
 *   agy-run "Summarize this in one line: ..."        human-readable output
 *   agy-run --json "..."                             clean JSON for agents
 *   agy-run -m gemini-2.5-flash "..."                pick a model
 *   agy-run -s "You are terse." "..."                system instruction
 *   echo "long prompt..." | agy-run --json           read prompt from stdin
 *
 * Default model: gemini-2.5-pro. JSON is emitted on stdout; errors exit nonzero.
 */

const { runPrompt, DEFAULT_MODEL } = require('../src/run');

function readStdin() {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve('');
    let buf = '';
    process.stdin.setEncoding('utf8');
    process.stdin.on('data', (c) => (buf += c));
    process.stdin.on('end', () => resolve(buf));
    // Guard: if nothing ever arrives, don't hang forever.
    setTimeout(() => resolve(buf), 200).unref();
  });
}

function parseArgs(argv) {
  const o = {
    json: false, help: false,
    model: DEFAULT_MODEL, system: null, project: null,
    temperature: null, maxOutputTokens: null, timeoutMs: 120000,
    prompt: null,
  };
  const rest = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--json' || a === '-j') o.json = true;
    else if (a === '--help' || a === '-h') o.help = true;
    else if (a === '--model' || a === '-m') o.model = argv[++i];
    else if (a === '--system' || a === '-s') o.system = argv[++i];
    else if (a === '--project') o.project = argv[++i];
    else if (a === '--temperature' || a === '-t') o.temperature = parseFloat(argv[++i]);
    else if (a === '--max-tokens') o.maxOutputTokens = parseInt(argv[++i], 10);
    else if (a === '--timeout') o.timeoutMs = Math.round(parseFloat(argv[++i]) * 1000);
    else rest.push(a);
  }
  if (rest.length) o.prompt = rest.join(' ');
  return o;
}

const HELP = `agy-run — headless Antigravity (agy) prompt runner

Usage:
  agy-run [options] "your prompt"
  echo "your prompt" | agy-run [options]

Options:
  -j, --json            Emit clean JSON (response text + token usage)
  -m, --model <id>      Model id (default ${DEFAULT_MODEL})
  -s, --system <text>   System instruction
  -t, --temperature <n> Sampling temperature
      --max-tokens <n>  Max output tokens
      --project <id>    Override cloudaicompanionProject
      --timeout <sec>   Per-request timeout in seconds (default 120)
  -h, --help            Show this help

JSON fields: model, model_version, text, finish_reason,
             usage{prompt_tokens,candidates_tokens,total_tokens},
             project, response_id, source, fetched_at
Exit codes:  0 ok  ·  1 error`;

(async () => {
  const opts = parseArgs(process.argv.slice(2));
  if (opts.help) {
    process.stdout.write(HELP + '\n');
    return;
  }
  if (!opts.prompt) {
    opts.prompt = (await readStdin()).trim();
  }
  if (!opts.prompt) {
    process.stderr.write('agy-run error: no prompt given (pass an argument or pipe via stdin)\n');
    process.exit(1);
  }
  try {
    const r = await runPrompt(opts);
    if (opts.json) {
      process.stdout.write(JSON.stringify(r, null, 2) + '\n');
    } else {
      process.stdout.write(r.text + '\n');
      const u = r.usage;
      process.stderr.write(
        `\n— ${r.model_version || r.model} · ` +
        `${u.prompt_tokens}+${u.candidates_tokens}=${u.total_tokens} tokens · ` +
        `${r.finish_reason}\n`
      );
    }
  } catch (e) {
    if (opts.json) {
      process.stdout.write(JSON.stringify({ error: e.message }, null, 2) + '\n');
    } else {
      process.stderr.write(`agy-run error: ${e.message}\n`);
    }
    process.exit(1);
  }
})();
