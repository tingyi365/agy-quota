#!/usr/bin/env node
'use strict';

/**
 * Round-trip probe: after the model asks for get_line_count, feed a
 * functionResponse back and confirm it produces a final text answer using the
 * tool output. Proves the tool_result -> functionResponse direction works too.
 */

const { loadCredential } = require('../src/credentials');
const { refreshAccessToken, loadCodeAssist, generateContent } = require('../src/api');

const MODEL = process.argv[2] || 'claude-opus-4-6-thinking';

async function main() {
  const cred = loadCredential();
  const { accessToken } = await refreshAccessToken(cred.refresh_token);
  const ca = await loadCodeAssist(accessToken);
  const project = ca.cloudaicompanionProject;

  const tools = [
    {
      functionDeclarations: [
        {
          name: 'get_line_count',
          description: 'Return the number of lines in a text file at the given path.',
          parameters: {
            type: 'object',
            properties: { path: { type: 'string' } },
            required: ['path'],
          },
        },
      ],
    },
  ];

  const request = {
    contents: [
      { role: 'user', parts: [{ text: 'How many lines are in "/tmp/foo.txt"? Use the get_line_count tool.' }] },
      {
        role: 'model',
        parts: [
          { text: "I'll check." },
          { functionCall: { name: 'get_line_count', args: { path: '/tmp/foo.txt' }, id: 'toolu_test_1' } },
        ],
      },
      {
        role: 'user',
        parts: [
          { functionResponse: { name: 'get_line_count', id: 'toolu_test_1', response: { content: '42' } } },
        ],
      },
    ],
    tools,
    toolConfig: { functionCallingConfig: { mode: 'AUTO' } },
  };

  const env = await generateContent(accessToken, { model: MODEL, project, request }, { timeoutMs: 120000 });
  console.log(JSON.stringify(env, null, 2));

  const parts = env?.response?.candidates?.[0]?.content?.parts || [];
  const text = parts.map((p) => p.text || '').join('');
  console.error('\n=== VERDICT ===');
  console.error(/42/.test(text) ? 'GO: model used the tool result (mentions 42).' : 'CHECK: final text = ' + text);
}

main().catch((e) => {
  console.error('PROBE ERROR:', e.message);
  process.exit(1);
});
