#!/usr/bin/env node
'use strict';

/**
 * agy-proxy — an Anthropic Messages API endpoint backed by Antigravity (agy).
 *
 * Point Claude Code (or any Anthropic SDK) at this server via
 *   ANTHROPIC_BASE_URL=http://127.0.0.1:8787
 * and every request is translated to the Antigravity Gemini-style
 * `generateContent` RPC and run on the user's free Ultra-subscription Claude
 * Opus quota instead of the paid Anthropic API. The Anthropic-shaped response
 * (incl. streaming SSE and tool_use/tool_result) is synthesized back.
 *
 * Credential + token refresh + OAuth-client discovery are reused verbatim from
 * the quota/run path (src/credentials.js, src/api.js). No token is ever
 * hard-coded; the agy keyring pipeline is the only source.
 *
 * Scope: M1 feasibility proof. Upstream is called non-streaming and buffered;
 * when the client asks for stream:true we replay the result as Anthropic SSE.
 */

const http = require('http');
const { loadCredential } = require('../src/credentials');
const { refreshAccessToken, loadCodeAssist, generateContent } = require('../src/api');

const PORT = parseInt(process.env.AGY_PROXY_PORT || '8787', 10);
const HOST = process.env.AGY_PROXY_HOST || '127.0.0.1';
// Every inbound model id is forced onto this Antigravity model — that is the
// whole point (drain the free Opus quota, not the paid API).
const UPSTREAM_MODEL = process.env.AGY_PROXY_MODEL || 'claude-opus-4-6-thinking';
const DEBUG = !!process.env.AGY_PROXY_DEBUG;

function log(...a) {
  process.stderr.write('[agy-proxy] ' + a.join(' ') + '\n');
}
function dbg(label, obj) {
  if (DEBUG) process.stderr.write(`[agy-proxy:debug] ${label} ${JSON.stringify(obj)}\n`);
}

// --- token cache -----------------------------------------------------------
let _tok = { accessToken: null, expMs: 0, project: null };

async function getAuth() {
  const now = Date.now();
  if (_tok.accessToken && now < _tok.expMs - 60000 && _tok.project) {
    return _tok;
  }
  const cred = loadCredential();
  const { accessToken, expiresIn } = await refreshAccessToken(cred.refresh_token);
  let project = _tok.project;
  if (!project) {
    const ca = await loadCodeAssist(accessToken);
    project = ca.cloudaicompanionProject;
    if (!project) throw new Error('Could not resolve cloudaicompanionProject from loadCodeAssist.');
  }
  _tok = { accessToken, expMs: now + (expiresIn || 3600) * 1000, project };
  return _tok;
}

// --- request translation: Anthropic Messages -> Gemini generateContent -----

/** Flatten an Anthropic `system` (string | array of text blocks) to one string. */
function systemToText(system) {
  if (!system) return '';
  if (typeof system === 'string') return system;
  if (Array.isArray(system)) {
    return system.map((b) => (typeof b === 'string' ? b : b.text || '')).join('\n');
  }
  return '';
}

/** Stringify Anthropic tool_result content (string | array of blocks) to text. */
function toolResultToText(content) {
  if (content == null) return '';
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    return content
      .map((b) => {
        if (typeof b === 'string') return b;
        if (b.type === 'text') return b.text || '';
        // images / other block types in a tool_result are dropped (M1 scope).
        return '';
      })
      .join('\n');
  }
  return String(content);
}

/**
 * Translate an Anthropic Messages request body into a Gemini generateContent
 * request ({ contents, systemInstruction?, tools?, toolConfig?, generationConfig? }).
 */
function anthropicToGemini(body) {
  const contents = [];

  for (const msg of body.messages || []) {
    const role = msg.role === 'assistant' ? 'model' : 'user';
    const parts = [];

    if (typeof msg.content === 'string') {
      if (msg.content) parts.push({ text: msg.content });
    } else if (Array.isArray(msg.content)) {
      for (const block of msg.content) {
        switch (block.type) {
          case 'text':
            if (block.text) parts.push({ text: block.text });
            break;
          case 'tool_use':
            parts.push({
              functionCall: { name: block.name, args: block.input || {}, id: block.id },
            });
            break;
          case 'tool_result':
            parts.push({
              functionResponse: {
                // Gemini requires a name; Antigravity/Vertex matches on id, but
                // we set both. The name is recovered below if we have it.
                name: block.__name || 'tool',
                id: block.tool_use_id,
                response: { content: toolResultToText(block.content) },
              },
            });
            break;
          case 'thinking':
          case 'redacted_thinking':
            // Prior-turn thinking is not replayed upstream (no signature round-trip in M1).
            break;
          case 'image':
            // Images dropped in M1 scope.
            break;
          default:
            if (block.text) parts.push({ text: block.text });
        }
      }
    }
    if (parts.length) contents.push({ role, parts });
  }

  // Recover tool names for functionResponses from the matching functionCall id.
  const idToName = {};
  for (const c of contents) {
    for (const p of c.parts) {
      if (p.functionCall && p.functionCall.id) idToName[p.functionCall.id] = p.functionCall.name;
    }
  }
  for (const c of contents) {
    for (const p of c.parts) {
      if (p.functionResponse && idToName[p.functionResponse.id]) {
        p.functionResponse.name = idToName[p.functionResponse.id];
      }
    }
  }

  const request = { contents };

  const sysText = systemToText(body.system);
  if (sysText) request.systemInstruction = { role: 'system', parts: [{ text: sysText }] };

  if (Array.isArray(body.tools) && body.tools.length) {
    request.tools = [
      {
        functionDeclarations: body.tools
          .filter((t) => t && t.name)
          .map((t) => ({
            name: t.name,
            description: t.description || '',
            parameters: sanitizeSchema(t.input_schema) || { type: 'object', properties: {} },
          })),
      },
    ];
    request.toolConfig = { functionCallingConfig: toolChoiceToConfig(body.tool_choice) };
  }

  const genCfg = {};
  if (typeof body.temperature === 'number') genCfg.temperature = body.temperature;
  if (typeof body.top_p === 'number') genCfg.topP = body.top_p;
  if (typeof body.top_k === 'number') genCfg.topK = body.top_k;
  if (typeof body.max_tokens === 'number') genCfg.maxOutputTokens = body.max_tokens;
  if (Array.isArray(body.stop_sequences) && body.stop_sequences.length) {
    genCfg.stopSequences = body.stop_sequences;
  }
  if (Object.keys(genCfg).length) request.generationConfig = genCfg;

  return request;
}

function toolChoiceToConfig(tc) {
  if (!tc) return { mode: 'AUTO' };
  if (tc.type === 'auto') return { mode: 'AUTO' };
  if (tc.type === 'none') return { mode: 'NONE' };
  if (tc.type === 'any') return { mode: 'ANY' };
  if (tc.type === 'tool' && tc.name) return { mode: 'ANY', allowedFunctionNames: [tc.name] };
  return { mode: 'AUTO' };
}

/**
 * JSON Schema -> Gemini Schema cleanup.
 *
 * Gemini's functionDeclarations parser accepts only a small OpenAPI-3.0 subset
 * and 400s on any unknown key (real Claude Code tool schemas carry
 * `propertyNames`, `additionalProperties`, `$schema`, `format: uri`, `pattern`,
 * `minLength`, …). So we WHITELIST the supported keys, recurse, normalize
 * oneOf->anyOf, and guarantee every node has a `type` (Gemini rejects typeless
 * nodes). Validation fidelity is intentionally sacrificed for acceptance —
 * the model still sees names/descriptions/enums, which is what drives tool use.
 */
const SCHEMA_KEYS = new Set([
  'type', 'description', 'nullable', 'enum', 'items', 'properties',
  'required', 'minItems', 'maxItems', 'minimum', 'maximum', 'default',
]);

function inferType(node) {
  if (node.properties) return 'object';
  if (node.items) return 'array';
  if (node.enum) return 'string';
  return 'string';
}

/**
 * Collapse an anyOf/oneOf list into ONE concrete schema. Antigravity's
 * Gemini->Anthropic conversion turns `anyOf` into a schema Anthropic's
 * 2020-12 validator rejects ("tools.N.custom.input_schema: JSON schema is
 * invalid") — proven by bisection on the TaskUpdate.status union. We pick the
 * richest member (one carrying an enum, else properties/items, else the first
 * typed one); nullable unions just lose their null arm, which is harmless.
 */
function collapseUnion(members) {
  const ms = (members || []).map(sanitizeSchema).filter((m) => m && typeof m === 'object');
  return (
    ms.find((m) => m.enum) ||
    ms.find((m) => m.properties || m.items) ||
    ms.find((m) => m.type) ||
    ms[0] ||
    { type: 'string' }
  );
}

function sanitizeSchema(schema) {
  if (schema == null || typeof schema !== 'object') return schema;
  if (Array.isArray(schema)) return schema.map(sanitizeSchema);

  // A union node collapses to a single member, inheriting the node's description.
  const union = schema.anyOf || schema.oneOf;
  if (union) {
    const picked = collapseUnion(union);
    if (schema.description && !picked.description) picked.description = schema.description;
    return picked;
  }

  const out = {};
  for (const [k, v] of Object.entries(schema)) {
    if (!SCHEMA_KEYS.has(k)) continue; // drop $schema, additionalProperties, propertyNames, format, pattern, …
    if (k === 'properties' && v && typeof v === 'object') {
      const props = {};
      for (const [pk, pv] of Object.entries(v)) props[pk] = sanitizeSchema(pv);
      out.properties = props;
    } else if (k === 'items') {
      out.items = sanitizeSchema(v);
    } else {
      out[k] = v;
    }
  }

  // Gemini rejects typeless schema nodes; always supply one.
  if (!out.type) out.type = inferType(out);
  return out;
}

// --- response translation: Gemini envelope -> Anthropic Message ------------

function mapStopReason(finishReason, hasToolUse) {
  if (hasToolUse) return 'tool_use';
  switch (finishReason) {
    case 'STOP':
      return 'end_turn';
    case 'MAX_TOKENS':
      return 'max_tokens';
    case 'OTHER':
      return 'end_turn';
    default:
      return 'end_turn';
  }
}

/** Build the Anthropic content[] array and stop_reason from a Gemini envelope. */
function geminiToAnthropicContent(env) {
  const cand = env?.response?.candidates?.[0];
  const parts = cand?.content?.parts || [];
  const content = [];
  let hasToolUse = false;

  for (const p of parts) {
    if (typeof p.text === 'string' && p.text.length && !p.thought) {
      content.push({ type: 'text', text: p.text });
    } else if (p.functionCall) {
      hasToolUse = true;
      content.push({
        type: 'tool_use',
        id: p.functionCall.id || genId('toolu'),
        name: p.functionCall.name,
        input: p.functionCall.args || {},
      });
    }
  }
  if (!content.length) content.push({ type: 'text', text: '' });

  const stop_reason = mapStopReason(cand?.finishReason, hasToolUse);
  return { content, stop_reason };
}

let _idCounter = 0;
function genId(prefix) {
  // Deterministic-enough unique id without Math.random (sandbox-safe).
  _idCounter += 1;
  return `${prefix}_${Date.now().toString(36)}${_idCounter.toString(36)}`;
}

function usageFromEnv(env) {
  const u = env?.response?.usageMetadata || {};
  return {
    input_tokens: u.promptTokenCount ?? 0,
    output_tokens: u.candidatesTokenCount ?? 0,
  };
}

// --- HTTP handling ---------------------------------------------------------

function readBody(req) {
  return new Promise((resolve, reject) => {
    let buf = '';
    req.on('data', (c) => (buf += c));
    req.on('end', () => resolve(buf));
    req.on('error', reject);
  });
}

function sendJson(res, status, obj) {
  const data = JSON.stringify(obj);
  res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(data) });
  res.end(data);
}

function sseWrite(res, event, data) {
  res.write(`event: ${event}\n`);
  res.write(`data: ${JSON.stringify(data)}\n\n`);
}

/** Replay a finished Anthropic message as the Anthropic streaming SSE sequence. */
function streamAnthropic(res, message) {
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache',
    Connection: 'keep-alive',
  });

  sseWrite(res, 'message_start', {
    type: 'message_start',
    message: { ...message, content: [], stop_reason: null, stop_sequence: null,
      usage: { input_tokens: message.usage.input_tokens, output_tokens: 0 } },
  });

  message.content.forEach((block, i) => {
    if (block.type === 'text') {
      sseWrite(res, 'content_block_start', {
        type: 'content_block_start', index: i, content_block: { type: 'text', text: '' },
      });
      if (block.text) {
        sseWrite(res, 'content_block_delta', {
          type: 'content_block_delta', index: i, delta: { type: 'text_delta', text: block.text },
        });
      }
      sseWrite(res, 'content_block_stop', { type: 'content_block_stop', index: i });
    } else if (block.type === 'tool_use') {
      sseWrite(res, 'content_block_start', {
        type: 'content_block_start', index: i,
        content_block: { type: 'tool_use', id: block.id, name: block.name, input: {} },
      });
      sseWrite(res, 'content_block_delta', {
        type: 'content_block_delta', index: i,
        delta: { type: 'input_json_delta', partial_json: JSON.stringify(block.input || {}) },
      });
      sseWrite(res, 'content_block_stop', { type: 'content_block_stop', index: i });
    }
  });

  sseWrite(res, 'message_delta', {
    type: 'message_delta',
    delta: { stop_reason: message.stop_reason, stop_sequence: null },
    usage: { output_tokens: message.usage.output_tokens },
  });
  sseWrite(res, 'message_stop', { type: 'message_stop' });
  res.end();
}

/**
 * Map an upstream failure (auth refresh OR generateContent) to an
 * Anthropic-shaped error with the right HTTP status and a short log tag.
 * We NEVER swallow: quota exhaustion, schema rejection and auth failures each
 * get a distinct, loud line so a worker that fell over is diagnosable from the
 * proxy log alone.
 */
function classifyUpstreamError(e) {
  const msg = e && e.message ? e.message : String(e);
  const m = /HTTP (\d{3})/.exec(msg);
  const status = m ? parseInt(m[1], 10) : 0;
  if (status === 429 || /RESOURCE_EXHAUSTED|exhaust|\bquota\b|rate.?limit/i.test(msg)) {
    return { tag: 'QUOTA-EXHAUSTED', http: 429, type: 'rate_limit_error',
      message: 'Antigravity Vertex pool exhausted / rate-limited — fall back to the paid Anthropic API. Upstream: ' + msg };
  }
  if (/JSON schema is invalid|INVALID_ARGUMENT|input_schema|functionDeclarations/i.test(msg)) {
    return { tag: 'SCHEMA-REJECTED', http: 400, type: 'invalid_request_error',
      message: 'Antigravity rejected the request schema (a tool input_schema likely survived sanitization unconverted). Upstream: ' + msg };
  }
  if (status === 401 || status === 403 || /UNAUTHENTICATED|PERMISSION_DENIED|refresh failed|cloudaicompanionProject/i.test(msg)) {
    return { tag: 'AUTH-FAILED', http: 502, type: 'authentication_error',
      message: 'Antigravity auth failed (token refresh or project resolution). Re-run an interactive agy login. Upstream: ' + msg };
  }
  return { tag: 'UPSTREAM-ERROR', http: 502, type: 'api_error', message: msg };
}

async function handleMessages(req, res, body) {
  const wantStream = !!body.stream;
  const toolCount = Array.isArray(body.tools) ? body.tools.length : 0;

  let auth, env;
  try {
    auth = await getAuth();
  } catch (e) {
    const c = classifyUpstreamError(e);
    log(`${c.tag} /v1/messages (auth) tools=${toolCount} stream=${wantStream}: ${c.message}`);
    return sendJson(res, c.http, { type: 'error', error: { type: c.type, message: c.message } });
  }

  const request = anthropicToGemini(body);
  dbg('gemini-request', { model: UPSTREAM_MODEL, request });

  try {
    env = await generateContent(
      auth.accessToken,
      { model: UPSTREAM_MODEL, project: auth.project, request },
      { timeoutMs: 180000 }
    );
  } catch (e) {
    const c = classifyUpstreamError(e);
    log(`${c.tag} /v1/messages tools=${toolCount} stream=${wantStream}: ${c.message}`);
    return sendJson(res, c.http, { type: 'error', error: { type: c.type, message: c.message } });
  }
  dbg('gemini-response', env);

  const { content, stop_reason } = geminiToAnthropicContent(env);
  const usage = usageFromEnv(env);
  const message = {
    id: env?.response?.responseId || genId('msg'),
    type: 'message',
    role: 'assistant',
    model: body.model || UPSTREAM_MODEL,
    content,
    stop_reason,
    stop_sequence: null,
    usage,
  };

  log(`OK /v1/messages tools=${toolCount} stream=${wantStream} -> ${stop_reason} in=${usage.input_tokens} out=${usage.output_tokens}`);
  if (wantStream) return streamAnthropic(res, message);
  return sendJson(res, 200, message);
}

function handleCountTokens(res, body) {
  // Rough estimate: ~4 chars/token over all text. Good enough for Claude Code's
  // pre-flight context checks; the proxy never bills on this.
  let chars = systemToText(body.system).length;
  for (const m of body.messages || []) {
    if (typeof m.content === 'string') chars += m.content.length;
    else if (Array.isArray(m.content)) {
      for (const b of m.content) chars += (b.text || JSON.stringify(b.input || b.content || '')).length;
    }
  }
  sendJson(res, 200, { input_tokens: Math.max(1, Math.ceil(chars / 4)) });
}

const server = http.createServer(async (req, res) => {
  const url = (req.url || '').split('?')[0];

  if (req.method === 'GET' && url === '/health') {
    // Cheap liveness + cached-auth readiness. `auth_ready` reflects whether we
    // currently hold a non-expired access token + resolved project (it does NOT
    // make a network call — the launcher's deeper check uses agy-quota).
    const authReady = !!(_tok.accessToken && Date.now() < _tok.expMs - 60000 && _tok.project);
    return sendJson(res, 200, {
      ok: true,
      upstream_model: UPSTREAM_MODEL,
      auth_ready: authReady,
      project: _tok.project || null,
    });
  }

  if (req.method !== 'POST') {
    return sendJson(res, 404, { type: 'error', error: { type: 'not_found_error', message: url } });
  }

  let body;
  try {
    const raw = await readBody(req);
    body = raw ? JSON.parse(raw) : {};
  } catch (e) {
    return sendJson(res, 400, { type: 'error', error: { type: 'invalid_request_error', message: 'bad JSON' } });
  }

  try {
    if (url === '/v1/messages') return await handleMessages(req, res, body);
    if (url === '/v1/messages/count_tokens') return handleCountTokens(res, body);
    return sendJson(res, 404, { type: 'error', error: { type: 'not_found_error', message: url } });
  } catch (e) {
    log('handler error:', e.message);
    if (!res.headersSent) {
      return sendJson(res, 500, { type: 'error', error: { type: 'api_error', message: e.message } });
    }
    res.end();
  }
});

// Only bind the port when run as a script. Requiring this file (e.g. from a
// unit test) exposes the pure translation/classification helpers without the
// listen side-effect.
if (require.main === module) {
  server.listen(PORT, HOST, () => {
    log(`listening on http://${HOST}:${PORT}  ->  Antigravity model "${UPSTREAM_MODEL}"`);
    log(`point a client at it with:  ANTHROPIC_BASE_URL=http://${HOST}:${PORT}`);

    // Startup self-check: prove the agy keyring credential refreshes and the
    // project resolves BEFORE any worker depends on us. We do not exit on
    // failure (a later agy re-login can recover, and /health must stay up so the
    // launcher can report) — but we log loudly so the boot failure is visible.
    getAuth()
      .then((a) => log(`auth self-check OK — project=${a.project}, token cached for ~${Math.round((a.expMs - Date.now()) / 60000)}min`))
      .catch((e) => log(`AUTH-SELFCHECK-FAILED at boot: ${e.message} — proxy is up but /v1/messages will 502 until an agy login is refreshed`));
  });

  // Don't let a stray upstream/socket error take the whole resident proxy down;
  // the launcher's restart loop is the backstop, but in-process we stay alive.
  process.on('uncaughtException', (e) => log(`uncaughtException: ${e && e.stack ? e.stack : e}`));
  process.on('unhandledRejection', (e) => log(`unhandledRejection: ${e && e.message ? e.message : e}`));
}

module.exports = {
  anthropicToGemini,
  geminiToAnthropicContent,
  sanitizeSchema,
  collapseUnion,
  mapStopReason,
  classifyUpstreamError,
};
