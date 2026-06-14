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
const {
  refreshAccessToken,
  loadCodeAssist,
  generateContent,
  fetchAvailableModels,
} = require('./api');

const DEFAULT_MODEL = 'gemini-2.5-pro';

/**
 * Best-effort provider label from a model id. The endpoint and request shape
 * are identical for every provider (Antigravity proxies them all through the
 * same Gemini-style `generateContent`), so this is purely informational.
 */
function providerForModel(id) {
  const s = String(id || '').toLowerCase();
  if (s.startsWith('claude') || s.includes('anthropic')) return 'anthropic';
  if (s.startsWith('gpt') || s.includes('oss') || /^o[1-9]/.test(s) || s.includes('openai')) return 'openai';
  if (s.startsWith('gemini') || s.startsWith('tab')) return 'google';
  return 'unknown';
}

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
    provider: providerForModel(model),
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

/**
 * List every model the logged-in account can actually call, with provider and
 * remaining quota. Returns a stable, sorted, agent-friendly array. Internal-only
 * and editor-helper (tab-completion) models are filtered out by default.
 *
 * @param {{host?:string, project?:string, includeInternal?:boolean}} [o]
 * @returns {Promise<{models:Array, source:string, fetched_at:string}>}
 */
async function listModels(o = {}) {
  const cred = loadCredential();
  const { accessToken } = await refreshAccessToken(cred.refresh_token);

  let project = o.project;
  if (!project) {
    try {
      const ca = await loadCodeAssist(accessToken, o.host);
      project = ca.cloudaicompanionProject || undefined;
    } catch (_) {
      /* project is optional for this call */
    }
  }

  const env = await fetchAvailableModels(accessToken, { host: o.host, project });
  const raw = env.models || {};
  const models = [];
  for (const [id, m] of Object.entries(raw)) {
    if (!o.includeInternal && (m.isInternal || /^tab[_-]/.test(id))) continue;
    const frac = m.quotaInfo && typeof m.quotaInfo.remainingFraction === 'number'
      ? m.quotaInfo.remainingFraction
      : null;
    models.push({
      model_id: id,
      provider: providerForModel(id),
      api_provider: (m.apiProvider || '').replace(/^API_PROVIDER_/, '') || null,
      display_name: m.displayName || null,
      supports_thinking: !!m.supportsThinking,
      supports_images: !!m.supportsImages,
      max_tokens: m.maxTokens || null,
      max_output_tokens: m.maxOutputTokens || null,
      recommended: !!m.recommended,
      remaining_fraction: frac,
      remaining_percent: frac == null ? null : Math.round(frac * 1000) / 10,
      reset_time: m.quotaInfo?.resetTime || null,
    });
  }
  models.sort((a, b) =>
    (a.provider + a.model_id).localeCompare(b.provider + b.model_id)
  );

  return {
    models,
    project: project || null,
    source: cred.source,
    fetched_at: new Date().toISOString(),
  };
}

module.exports = { runPrompt, listModels, providerForModel, DEFAULT_MODEL };
