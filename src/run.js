'use strict';

/**
 * Headless task runner for Antigravity (agy).
 *
 * Sends a prompt to the agy generative endpoint (`v1internal:generateContent`)
 * over plain HTTPS — no IDE, language-server, loopback, or TTY required — and
 * returns the model's text plus token usage. This is what lets an orchestrator
 * offload work onto the agy free quota without driving the (TTY-only,
 * headless-hostile) agy console binary.
 *
 * Credential + token-refresh + OAuth-client discovery are reused verbatim from
 * the quota path (src/credentials.js, src/api.js, src/oauth-client.js).
 */

const { loadCredential } = require('./credentials');
const { refreshAccessToken, loadCodeAssist, generateContent } = require('./api');

const DEFAULT_MODEL = 'gemini-2.5-pro';

/** Pull the readable text out of a Code Assist generateContent envelope. */
function extractText(envelope) {
  const cand = envelope?.response?.candidates?.[0];
  const parts = cand?.content?.parts || [];
  return parts
    .map((p) => (typeof p.text === 'string' ? p.text : ''))
    .join('')
    .trim();
}

function extractUsage(envelope) {
  const u = envelope?.response?.usageMetadata || {};
  return {
    prompt_tokens: u.promptTokenCount ?? null,
    candidates_tokens: u.candidatesTokenCount ?? null,
    total_tokens: u.totalTokenCount ?? null,
  };
}

/**
 * Run a single prompt against agy and return a stable, agent-friendly result.
 *
 * @param {object} o
 * @param {string} o.prompt           the user prompt (required)
 * @param {string} [o.model]          model id (default gemini-2.5-pro)
 * @param {string} [o.system]         optional system instruction
 * @param {string} [o.project]        override cloudaicompanionProject
 * @param {number} [o.temperature]    optional generationConfig.temperature
 * @param {number} [o.maxOutputTokens] optional generationConfig cap
 * @param {string} [o.host]           override API host
 * @param {number} [o.timeoutMs]      per-request timeout (default 120000)
 * @returns {Promise<object>}
 */
async function runPrompt(o = {}) {
  if (!o.prompt || !String(o.prompt).trim()) {
    throw new Error('runPrompt: a non-empty prompt is required.');
  }
  const model = o.model || DEFAULT_MODEL;

  const cred = loadCredential();
  const { accessToken } = await refreshAccessToken(cred.refresh_token);

  // Resolve the project the account is bound to (cached-free, one call).
  let project = o.project;
  if (!project) {
    const ca = await loadCodeAssist(accessToken, o.host);
    project = ca.cloudaicompanionProject;
    if (!project) {
      throw new Error('Could not resolve cloudaicompanionProject; pass --project explicitly.');
    }
  }

  const request = {
    contents: [{ role: 'user', parts: [{ text: String(o.prompt) }] }],
  };
  if (o.system) {
    request.systemInstruction = { role: 'system', parts: [{ text: String(o.system) }] };
  }
  const genCfg = {};
  if (typeof o.temperature === 'number') genCfg.temperature = o.temperature;
  if (typeof o.maxOutputTokens === 'number') genCfg.maxOutputTokens = o.maxOutputTokens;
  if (Object.keys(genCfg).length) request.generationConfig = genCfg;

  const envelope = await generateContent(
    accessToken,
    { model, project, request },
    { host: o.host, timeoutMs: o.timeoutMs }
  );

  const cand = envelope?.response?.candidates?.[0];
  return {
    model,
    model_version: envelope?.response?.modelVersion || null,
    text: extractText(envelope),
    finish_reason: cand?.finishReason || null,
    usage: extractUsage(envelope),
    project,
    response_id: envelope?.response?.responseId || null,
    source: cred.source,
    fetched_at: new Date().toISOString(),
  };
}

module.exports = { runPrompt, DEFAULT_MODEL };
