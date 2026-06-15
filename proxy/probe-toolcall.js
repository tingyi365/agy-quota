#!/usr/bin/env node
'use strict';

/**
 * GO/NO-GO probe for the Anthropic->Antigravity translation proxy.
 *
 * The ONLY unproven assumption behind the whole proxy is: when Antigravity
 * proxies a Claude model, does its Gemini-style `generateContent` accept
 * Gemini-format tool declarations (functionDeclarations) AND return a
 * `functionCall` part the way Gemini does? agy-run never sent tools, so this
 * was never exercised. Everything else (text, system, usage) is already proven.
 *
 * This script issues a single Claude request with one tool and dumps the raw
 * request + raw response so we can decide M1 go/no-go on evidence, not faith.
 */

const { loadCredential } = require('../src/credentials');
const { refreshAccessToken, loadCodeAssist, generateContent } = require('../src/api');

const MODEL = process.argv[2] || 'claude-opus-4-6-thinking';

async function main() {
  const cred = loadCredential();
  const { accessToken } = await refreshAccessToken(cred.refresh_token);
  const ca = await loadCodeAssist(accessToken);
  const project = ca.cloudaicompanionProject;

  // A single, unambiguous tool. The prompt makes calling it the only sane move.
  const request = {
    contents: [
      {
        role: 'user',
        parts: [
          {
            text:
              'I need the number of lines in the file at path "/tmp/foo.txt". ' +
              'Use the get_line_count tool to find out. Do not guess.',
          },
        ],
      },
    ],
    tools: [
      {
        functionDeclarations: [
          {
            name: 'get_line_count',
            description: 'Return the number of lines in a text file at the given path.',
            parameters: {
              type: 'object',
              properties: {
                path: { type: 'string', description: 'Absolute path to the file.' },
              },
              required: ['path'],
            },
          },
        ],
      },
    ],
    toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
  };

  const payload = { model: MODEL, project, request };
  console.error('=== RAW REQUEST payload ===');
  console.error(JSON.stringify(payload, null, 2));

  const env = await generateContent(accessToken, payload, { timeoutMs: 120000 });

  console.error('\n=== RAW RESPONSE envelope ===');
  console.log(JSON.stringify(env, null, 2));

  // Verdict
  const parts = env?.response?.candidates?.[0]?.content?.parts || [];
  const fc = parts.find((p) => p.functionCall);
  console.error('\n=== VERDICT ===');
  if (fc) {
    console.error('GO: model returned a functionCall:', JSON.stringify(fc.functionCall));
  } else {
    console.error('NO functionCall part returned. Parts seen:', JSON.stringify(parts).slice(0, 500));
  }
}

main().catch((e) => {
  console.error('PROBE ERROR:', e.message);
  process.exit(1);
});
