'use strict';

/**
 * Google Code Assist (Antigravity backend) API client.
 *
 * Refreshes the agy access token and fetches the real per-model usage quota
 * for the logged-in consumer account — the same endpoints the agy binary
 * itself calls. No IDE / language-server / loopback required.
 */

const https = require('https');
const { getClientCandidates, cacheWorkingClient } = require('./oauth-client');
const { saveRefreshToken } = require('./credentials');

// Both hosts answer identically; daily- is the Antigravity-flavored alias.
const DEFAULT_HOST = 'cloudcode-pa.googleapis.com';

/**
 * Headers that identify the caller as the Antigravity IDE. These are REQUIRED
 * to reach the non-Google providers (Anthropic Claude, OpenAI GPT-OSS): without
 * the `Client-Metadata: {"ideType":"ANTIGRAVITY"}` marker the backend answers
 * 404 NOT_FOUND for those models (Gemini works either way). Sending them is
 * harmless for Gemini, so we attach them to every generative call.
 */
const ANTIGRAVITY_HEADERS = {
  'User-Agent':
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) ' +
    'Antigravity/1.0.0 Chrome/138.0.7204.235 Electron/37.3.1 Safari/537.36',
  'X-Goog-Api-Client': 'google-cloud-sdk vscode_cloudshelleditor/0.1',
  'Client-Metadata': '{"ideType":"ANTIGRAVITY","platform":"WINDOWS","pluginType":"GEMINI"}',
};

function postJson(url, headers, body, timeoutMs = 12000) {
  return new Promise((resolve, reject) => {
    const data = body == null ? '' : body;
    const req = https.request(
      url,
      {
        method: 'POST',
        headers: { 'Content-Length': Buffer.byteLength(data), ...headers },
        timeout: timeoutMs,
      },
      (res) => {
        let buf = '';
        res.on('data', (c) => (buf += c));
        res.on('end', () => resolve({ status: res.statusCode, body: buf }));
      }
    );
    req.on('error', reject);
    req.on('timeout', () => {
      req.destroy(new Error('request timed out'));
    });
    if (data) req.write(data);
    req.end();
  });
}

async function tryRefresh(clientId, clientSecret, refreshToken) {
  const body = new URLSearchParams({
    client_id: clientId,
    client_secret: clientSecret,
    refresh_token: refreshToken,
    grant_type: 'refresh_token',
  }).toString();
  return postJson(
    'https://oauth2.googleapis.com/token',
    { 'Content-Type': 'application/x-www-form-urlencoded' },
    body
  );
}

/**
 * Exchange a refresh_token for a fresh access_token. The OAuth client id/secret
 * are discovered from the local agy binary (not hard-coded here); we try each
 * candidate pair until one works and cache the winner.
 */
async function refreshAccessToken(refreshToken) {
  const candidates = getClientCandidates();
  let lastErr = 'no candidates';
  for (const { clientId, clientSecret } of candidates) {
    const r = await tryRefresh(clientId, clientSecret, refreshToken);
    if (r.status === 200) {
      const j = JSON.parse(r.body);
      if (j.access_token) {
        cacheWorkingClient(clientId, clientSecret);
        // H3: handle refresh_token rotation. If upstream returned a new one,
        // persist it (best-effort) so the old token going stale doesn't force a
        // manual `agy login`. Returns the effective refresh_token for callers.
        let effectiveRefresh = refreshToken;
        if (j.refresh_token && j.refresh_token !== refreshToken) {
          try { saveRefreshToken(j.refresh_token); } catch (_) {}
          effectiveRefresh = j.refresh_token;
        }
        return { accessToken: j.access_token, expiresIn: j.expires_in, refreshToken: effectiveRefresh };
      }
    }
    lastErr = `HTTP ${r.status}: ${r.body.slice(0, 120)}`;
  }
  throw new Error(`Token refresh failed for all ${candidates.length} client candidate(s). Last: ${lastErr}`);
}

async function callV1Internal(host, endpoint, accessToken) {
  const r = await postJson(
    `https://${host}/v1internal:${endpoint}`,
    { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    '{}'
  );
  if (r.status !== 200) {
    throw new Error(`${endpoint} failed (HTTP ${r.status}): ${r.body.slice(0, 200)}`);
  }
  return JSON.parse(r.body);
}

/** Raw per-model quota buckets. */
function fetchUserQuota(accessToken, host = DEFAULT_HOST) {
  return callV1Internal(host, 'retrieveUserQuota', accessToken);
}

/** Tier + account context (incl. cloudaicompanionProject). */
function loadCodeAssist(accessToken, host = DEFAULT_HOST) {
  return callV1Internal(host, 'loadCodeAssist', accessToken);
}

/**
 * Run a generation request through the Antigravity generative endpoint
 * (`v1internal:generateContent`) — the same RPC the agy binary calls.
 *
 * @param {string} accessToken
 * @param {{model:string, project:string, request:object}} payload
 *        request is a standard Gemini GenerateContentRequest
 *        ({ contents, systemInstruction?, generationConfig?, ... }).
 * @param {{host?:string, timeoutMs?:number}} [opts]
 * @returns {Promise<object>} the raw Code Assist envelope ({ response, ... }).
 */
async function generateContent(accessToken, payload, opts = {}) {
  const host = opts.host || DEFAULT_HOST;
  const timeoutMs = opts.timeoutMs || 120000;
  const r = await postJson(
    `https://${host}/v1internal:generateContent`,
    {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...ANTIGRAVITY_HEADERS,
    },
    JSON.stringify(payload),
    timeoutMs
  );
  if (r.status !== 200) {
    throw new Error(`generateContent failed (HTTP ${r.status}): ${r.body.slice(0, 400)}`);
  }
  return JSON.parse(r.body);
}

/**
 * List every model the account can call (Gemini + Claude + GPT-OSS), with per
 * model quota. This is the authoritative source of valid model ids — the keys
 * of the returned `models` map are exactly what `generateContent` expects.
 *
 * @param {string} accessToken
 * @param {{host?:string, project?:string, timeoutMs?:number}} [opts]
 * @returns {Promise<object>} raw envelope: { models: { <id>: {…}, … } }
 */
async function fetchAvailableModels(accessToken, opts = {}) {
  const host = opts.host || DEFAULT_HOST;
  const timeoutMs = opts.timeoutMs || 30000;
  const body = opts.project ? JSON.stringify({ project: opts.project }) : '{}';
  const r = await postJson(
    `https://${host}/v1internal:fetchAvailableModels`,
    {
      Authorization: `Bearer ${accessToken}`,
      'Content-Type': 'application/json',
      ...ANTIGRAVITY_HEADERS,
    },
    body,
    timeoutMs
  );
  if (r.status !== 200) {
    throw new Error(`fetchAvailableModels failed (HTTP ${r.status}): ${r.body.slice(0, 200)}`);
  }
  return JSON.parse(r.body);
}

module.exports = {
  refreshAccessToken,
  fetchUserQuota,
  loadCodeAssist,
  generateContent,
  fetchAvailableModels,
  ANTIGRAVITY_HEADERS,
  DEFAULT_HOST,
};
