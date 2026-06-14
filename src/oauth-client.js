'use strict';

/**
 * Discover agy's OAuth client credentials *at runtime* from the locally
 * installed `agy` binary, instead of hard-coding Google's client secret in
 * this (public) source tree.
 *
 * The agy executable embeds its own OAuth client id(s) and secret(s). We scan
 * the binary for them, then the caller tries each (id, secret) pair against
 * the token endpoint and caches whichever one works.
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const CACHE_FILE = path.join(os.tmpdir(), 'agy-quota-oauth-client.json');

function candidateBinaryPaths() {
  const out = [];
  const local = process.env.LOCALAPPDATA;
  if (local) out.push(path.join(local, 'agy', 'bin', process.platform === 'win32' ? 'agy.exe' : 'agy'));
  // PATH lookup
  const exe = process.platform === 'win32' ? 'agy.exe' : 'agy';
  for (const dir of (process.env.PATH || '').split(path.delimiter)) {
    if (dir) out.push(path.join(dir, exe));
  }
  // common unix install spots
  if (process.platform !== 'win32') {
    out.push('/usr/local/bin/agy', path.join(os.homedir(), '.local', 'bin', 'agy'));
  }
  return out;
}

function findBinary() {
  if (process.env.AGY_BIN) {
    try { if (fs.existsSync(process.env.AGY_BIN)) return process.env.AGY_BIN; } catch (_) {}
  }
  for (const p of candidateBinaryPaths()) {
    try { if (fs.existsSync(p) && fs.statSync(p).isFile()) return p; } catch (_) {}
  }
  return null;
}

/** Scan the binary for OAuth client ids and GOCSPX secrets. */
function extractFromBinary(binPath) {
  const buf = fs.readFileSync(binPath);
  const s = buf.toString('latin1');
  const uniq = (re) => {
    const set = new Set();
    let m;
    while ((m = re.exec(s))) set.add(m[0]);
    return [...set];
  };
  const ids = uniq(/[0-9]{10,}-[a-z0-9]{16,}\.apps\.googleusercontent\.com/g);
  const secrets = uniq(/GOCSPX-[A-Za-z0-9_-]{28}/g);
  return { ids, secrets };
}

/**
 * Return candidate {clientId, clientSecret} pairs to try, cached pair first.
 * Throws if no agy binary can be found to extract them from.
 */
function getClientCandidates() {
  const candidates = [];

  // 1) cached working pair
  try {
    const c = JSON.parse(fs.readFileSync(CACHE_FILE, 'utf8'));
    if (c.clientId && c.clientSecret) candidates.push({ clientId: c.clientId, clientSecret: c.clientSecret });
  } catch (_) {}

  // 2) everything we can pull from the binary (all id x secret combos)
  const bin = findBinary();
  if (bin) {
    const { ids, secrets } = extractFromBinary(bin);
    for (const id of ids) for (const sec of secrets) candidates.push({ clientId: id, clientSecret: sec });
  }

  if (!candidates.length) {
    throw new Error(
      'Could not locate the agy binary to read its OAuth client. ' +
      'Set AGY_BIN to the agy executable path, or ensure agy is installed.'
    );
  }
  // de-dupe
  const seen = new Set();
  return candidates.filter((c) => {
    const k = c.clientId + '|' + c.clientSecret;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

/** Persist the pair that successfully refreshed a token. */
function cacheWorkingClient(clientId, clientSecret) {
  try {
    fs.writeFileSync(CACHE_FILE, JSON.stringify({ clientId, clientSecret }), 'utf8');
  } catch (_) {}
}

module.exports = { getClientCandidates, cacheWorkingClient, findBinary, extractFromBinary, CACHE_FILE };
