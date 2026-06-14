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

// Both hosts answer identically; daily- is the Antigravity-flavored alias.
const DEFAULT_HOST = 'cloudcode-pa.googleapis.com';

function postJson(url, headers, body) {
  return new Promise((resolve, reject) => {
    const data = body == null ? '' : body;
    const req = https.request(
      url,
      {
        method: 'POST',
        headers: { 'Content-Length': Buffer.byteLength(data), ...headers },
        timeout: 12000,
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
        return { accessToken: j.access_token, expiresIn: j.expires_in };
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

/** Tier + account context. */
function loadCodeAssist(accessToken, host = DEFAULT_HOST) {
  return callV1Internal(host, 'loadCodeAssist', accessToken);
}

module.exports = {
  refreshAccessToken,
  fetchUserQuota,
  loadCodeAssist,
  DEFAULT_HOST,
};
