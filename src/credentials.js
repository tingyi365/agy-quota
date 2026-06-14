'use strict';

/**
 * Credential resolution for Antigravity (agy) CLI.
 *
 * agy stores its OAuth credentials in the OS keyring, NOT in a plain file.
 * On Windows that is the Credential Manager, as a *generic* credential named
 * `gemini:antigravity` whose blob is UTF-8 JSON:
 *
 *   { "token": { "access_token", "token_type", "refresh_token", "expiry" },
 *     "auth_method": "consumer" }
 *
 * The stale `~/.gemini/oauth_creds.json` file (old Gemini CLI) is used only as
 * a last-resort fallback on non-Windows platforms.
 */

const os = require('os');
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const KEYRING_TARGET = 'gemini:antigravity';

/**
 * Read the agy credential blob from the Windows Credential Manager via a
 * short PowerShell P/Invoke of advapi32!CredRead. Returns the parsed object
 * or throws with a helpful message.
 */
function readWindowsKeyring() {
  const ps = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$WarningPreference = 'SilentlyContinue'
$sig = @'
using System;
using System.Runtime.InteropServices;
public class Cred {
  [DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern bool CredRead(string target, int type, int flags, out IntPtr credential);
  [DllImport("advapi32.dll", SetLastError=false)]
  public static extern void CredFree(IntPtr cred);
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct CREDENTIAL {
    public int Flags; public int Type; public IntPtr TargetName; public IntPtr Comment;
    public long LastWritten; public int CredentialBlobSize; public IntPtr CredentialBlob;
    public int Persist; public int AttributeCount; public IntPtr Attributes;
    public IntPtr TargetAlias; public IntPtr UserName;
  }
  public static byte[] Read(string target) {
    IntPtr p;
    if (!CredRead(target, 1, 0, out p)) return null;
    try {
      var c = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL));
      byte[] b = new byte[c.CredentialBlobSize];
      Marshal.Copy(c.CredentialBlob, b, 0, c.CredentialBlobSize);
      return b;
    } finally { CredFree(p); }
  }
}
'@
Add-Type -TypeDefinition $sig | Out-Null
$b = [Cred]::Read('${KEYRING_TARGET}')
if ($b -eq $null) { [Console]::Error.WriteLine('CRED_NOT_FOUND'); exit 3 }
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8
[Console]::Out.Write([System.Text.Encoding]::UTF8.GetString($b))
`.trim();

  const encoded = Buffer.from(ps, 'utf16le').toString('base64');
  let out;
  try {
    out = execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
      encoding: 'utf8',
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    });
  } catch (e) {
    if (e.stderr && /CRED_NOT_FOUND/.test(e.stderr)) {
      throw new Error(
        `Credential "${KEYRING_TARGET}" not found in Windows Credential Manager.\n` +
        `Run an interactive "agy" login once (so it stores the keyring token), then retry.`
      );
    }
    throw new Error(`Failed to read keyring via PowerShell: ${e.message}`);
  }

  // Defensively strip anything before the first JSON object (e.g. a stray
  // PowerShell CLIXML progress banner) so parsing stays robust.
  const start = out.indexOf('{');
  const jsonText = start >= 0 ? out.slice(start) : out;

  let blob;
  try {
    blob = JSON.parse(jsonText);
  } catch (_) {
    throw new Error('Keyring blob was not valid JSON (unexpected agy credential format).');
  }
  return blob;
}

/** Fallback for non-Windows: the old gemini-cli oauth_creds.json. */
function readFileCreds() {
  const p = path.join(os.homedir(), '.gemini', 'oauth_creds.json');
  if (!fs.existsSync(p)) {
    throw new Error(`No keyring support on ${process.platform} and ${p} not found.`);
  }
  const j = JSON.parse(fs.readFileSync(p, 'utf8'));
  return { token: j, auth_method: 'file' };
}

/**
 * Resolve the agy credential into a normalized shape:
 *   { access_token, refresh_token, expiry (Date|null), auth_method, source }
 */
function loadCredential() {
  let blob;
  let source;
  if (process.platform === 'win32') {
    blob = readWindowsKeyring();
    source = 'windows-keyring';
  } else {
    blob = readFileCreds();
    source = 'oauth_creds.json';
  }

  const tok = blob.token || blob;
  const expiryRaw = tok.expiry || tok.expiry_date || null;
  let expiry = null;
  if (typeof expiryRaw === 'number') expiry = new Date(expiryRaw);
  else if (typeof expiryRaw === 'string') {
    const d = new Date(expiryRaw);
    if (!isNaN(d.getTime())) expiry = d;
  }

  if (!tok.refresh_token) {
    throw new Error('Credential has no refresh_token; cannot refresh access token.');
  }

  return {
    access_token: tok.access_token || null,
    refresh_token: tok.refresh_token,
    expiry,
    auth_method: blob.auth_method || 'unknown',
    source,
  };
}

module.exports = { loadCredential, KEYRING_TARGET };
