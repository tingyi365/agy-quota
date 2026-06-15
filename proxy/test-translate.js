#!/usr/bin/env node
'use strict';

/**
 * Pure unit tests for the proxy's translation + error-classification helpers.
 * No network: server.js exports these because it only listens when run directly.
 *
 *   node proxy/test-translate.js
 */

const assert = require('assert');
const {
  anthropicToGemini,
  geminiToAnthropicContent,
  sanitizeSchema,
  mapStopReason,
  classifyUpstreamError,
} = require('./server');

let n = 0;
function ok(label) { n++; console.log(`  ok ${n} - ${label}`); }

// --- error classification (the "don't silently swallow" contract) -----------
{
  const quota = classifyUpstreamError(new Error('generateContent failed (HTTP 429): {"error":{"status":"RESOURCE_EXHAUSTED"}}'));
  assert.strictEqual(quota.tag, 'QUOTA-EXHAUSTED');
  assert.strictEqual(quota.http, 429);
  assert.strictEqual(quota.type, 'rate_limit_error');
  ok('429 RESOURCE_EXHAUSTED -> QUOTA-EXHAUSTED / rate_limit_error / 429');

  const schema = classifyUpstreamError(new Error('generateContent failed (HTTP 400): tools.5.custom.input_schema: JSON schema is invalid'));
  assert.strictEqual(schema.tag, 'SCHEMA-REJECTED');
  assert.strictEqual(schema.http, 400);
  assert.strictEqual(schema.type, 'invalid_request_error');
  ok('400 "JSON schema is invalid" -> SCHEMA-REJECTED / invalid_request_error / 400');

  const auth = classifyUpstreamError(new Error('Token refresh failed for all 3 client candidate(s). Last: HTTP 400'));
  assert.strictEqual(auth.tag, 'AUTH-FAILED');
  assert.strictEqual(auth.type, 'authentication_error');
  ok('token refresh failure -> AUTH-FAILED / authentication_error');

  const other = classifyUpstreamError(new Error('generateContent failed (HTTP 404): {"status":"NOT_FOUND"}'));
  assert.strictEqual(other.tag, 'UPSTREAM-ERROR');
  assert.strictEqual(other.http, 502);
  ok('404 NOT_FOUND -> generic UPSTREAM-ERROR / 502');
}

// --- stop_reason coverage ---------------------------------------------------
{
  assert.strictEqual(mapStopReason('STOP', false), 'end_turn');
  assert.strictEqual(mapStopReason('MAX_TOKENS', false), 'max_tokens');
  assert.strictEqual(mapStopReason('OTHER', true), 'tool_use');   // Antigravity OTHER + functionCall
  assert.strictEqual(mapStopReason('STOP', true), 'tool_use');    // tool presence wins
  assert.strictEqual(mapStopReason('SOMETHING_NEW', false), 'end_turn');
  ok('mapStopReason: STOP/MAX_TOKENS/OTHER+tool/unknown all covered');
}

// --- schema sanitizer: union collapse + keyword whitelist + type backfill ---
{
  // A TaskUpdate.status-like union that broke Antigravity's draft-2020-12 check.
  const raw = {
    $schema: 'https://json-schema.org/draft/2020-12/schema',
    type: 'object',
    additionalProperties: false,
    properties: {
      status: {
        description: 'task status',
        anyOf: [
          { type: 'string', enum: ['todo', 'doing', 'done'] },
          { type: 'null' },
        ],
      },
      path: { type: 'string', format: 'uri', pattern: '^/', minLength: 1 },
      items: { type: 'array', items: { type: 'string' } },
    },
    required: ['status'],
    propertyNames: { pattern: '^[a-z]+$' },
  };
  const out = sanitizeSchema(raw);
  assert.ok(!('$schema' in out), '$schema dropped');
  assert.ok(!('additionalProperties' in out), 'additionalProperties dropped');
  assert.ok(!('propertyNames' in out), 'propertyNames dropped');
  // union collapsed to the enum-bearing member (no anyOf survives)
  assert.ok(!out.properties.status.anyOf, 'status.anyOf collapsed');
  assert.deepStrictEqual(out.properties.status.enum, ['todo', 'doing', 'done']);
  assert.strictEqual(out.properties.status.description, 'task status'); // inherited
  // unsupported string keywords stripped, type preserved
  assert.ok(!('format' in out.properties.path), 'format dropped');
  assert.ok(!('pattern' in out.properties.path), 'pattern dropped');
  assert.strictEqual(out.properties.path.type, 'string');
  // nested array items recursed
  assert.strictEqual(out.properties.items.items.type, 'string');
  ok('sanitizeSchema: collapses anyOf, drops unsupported keys, keeps enum/type, recurses');

  // typeless node gets a backfilled type (Gemini rejects typeless)
  const inferred = sanitizeSchema({ properties: { a: { enum: ['x'] } } });
  assert.strictEqual(inferred.type, 'object');
  assert.strictEqual(inferred.properties.a.type, 'string');
  ok('sanitizeSchema: backfills missing type (object/string)');
}

// --- tool round-trip: functionResponse name recovered from prior call -------
{
  const body = {
    messages: [
      { role: 'user', content: 'read it' },
      { role: 'assistant', content: [
        { type: 'text', text: 'ok' },
        { type: 'tool_use', id: 'toolu_1', name: 'read_file', input: { path: '/a' } },
      ] },
      { role: 'user', content: [
        { type: 'tool_result', tool_use_id: 'toolu_1', content: 'hello' },
      ] },
    ],
    tools: [{ name: 'read_file', description: 'r', input_schema: { type: 'object', properties: { path: { type: 'string' } } } }],
  };
  const g = anthropicToGemini(body);
  const fr = g.contents.flatMap((c) => c.parts).find((p) => p.functionResponse);
  assert.strictEqual(fr.functionResponse.name, 'read_file', 'name recovered from matching functionCall id');
  assert.strictEqual(fr.functionResponse.response.content, 'hello');
  assert.ok(g.tools[0].functionDeclarations[0].parameters.type === 'object');
  ok('anthropicToGemini: tool_result name recovered + content carried + tools declared');
}

// --- gemini envelope -> anthropic content: multi-tool concurrency -----------
{
  const env = { response: { candidates: [{ finishReason: 'OTHER', content: { parts: [
    { text: 'doing two things' },
    { functionCall: { name: 'a', args: { x: 1 }, id: 't1' } },
    { functionCall: { name: 'b', args: { y: 2 }, id: 't2' } },
    { text: 'secret', thought: true },          // thinking part must be dropped
  ] } }] } };
  const { content, stop_reason } = geminiToAnthropicContent(env);
  assert.strictEqual(stop_reason, 'tool_use');
  const tools = content.filter((c) => c.type === 'tool_use');
  assert.strictEqual(tools.length, 2, 'both concurrent tool calls surfaced');
  assert.ok(!content.some((c) => c.type === 'text' && c.text === 'secret'), 'thinking part dropped');
  ok('geminiToAnthropicContent: 2 concurrent tool_use + thinking dropped + stop_reason tool_use');
}

console.log(`\nALL ${n} TESTS PASSED`);
