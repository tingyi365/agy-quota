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

/**
 * Persist a blob back into the Windows Credential Manager via CredWriteW.
 * Reads the existing credential first to preserve its UserName / Persist / Type
 * exactly (go-keyring is sensitive to these); only the blob bytes are replaced.
 * Throws on failure — callers treat write-back as best-effort and swallow.
 */
function writeWindowsKeyring(blob) {
  const jsonText = JSON.stringify(blob);
  const b64 = Buffer.from(jsonText, 'utf8').toString('base64');
  const ps = `
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$WarningPreference = 'SilentlyContinue'
$sig = @'
using System;
using System.Runtime.InteropServices;
public class CredWriter {
  [DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
  public static extern bool CredRead(string target, int type, int flags, out IntPtr credential);
  [DllImport("advapi32.dll", SetLastError=true, CharSet=CharSet.Unicode, EntryPoint="CredWriteW")]
  public static extern bool CredWrite(ref CREDENTIAL userCredential, int flags);
  [DllImport("advapi32.dll", SetLastError=false)]
  public static extern void CredFree(IntPtr cred);
  [StructLayout(LayoutKind.Sequential, CharSet=CharSet.Unicode)]
  public struct CREDENTIAL {
    public int Flags; public int Type; public IntPtr TargetName; public IntPtr Comment;
    public long LastWritten; public int CredentialBlobSize; public IntPtr CredentialBlob;
    public int Persist; public int AttributeCount; public IntPtr Attributes;
    public IntPtr TargetAlias; public IntPtr UserName;
  }
  public static int Write(string target, byte[] blob) {
    int persist = 2; int type = 1; string userName = null;
    IntPtr p;
    if (CredRead(target, 1, 0, out p)) {
      try {
        var ex = (CREDENTIAL)Marshal.PtrToStructure(p, typeof(CREDENTIAL));
        persist = ex.Persist; type = ex.Type;
        if (ex.UserName != IntPtr.Zero) userName = Marshal.PtrToStringUni(ex.UserName);
      } finally { CredFree(p); }
    }
    IntPtr blobPtr = Marshal.AllocHGlobal(blob.Length);
    Marshal.Copy(blob, 0, blobPtr, blob.Length);
    IntPtr targetPtr = Marshal.StringToCoTaskMemUni(target);
    IntPtr userPtr = userName != null ? Marshal.StringToCoTaskMemUni(userName) : IntPtr.Zero;
    var c = new CREDENTIAL();
    c.Type = type; c.TargetName = targetPtr;
    c.CredentialBlobSize = blob.Length; c.CredentialBlob = blobPtr;
    c.Persist = persist; c.UserName = userPtr;
    bool ok = CredWrite(ref c, 0);
    int err = ok ? 0 : Marshal.GetLastWin32Error();
    Marshal.FreeHGlobal(blobPtr);
    Marshal.FreeCoTaskMem(targetPtr);
    if (userPtr != IntPtr.Zero) Marshal.FreeCoTaskMem(userPtr);
    return err;
  }
}
'@
Add-Type -TypeDefinition $sig | Out-Null
$blob = [System.Convert]::FromBase64String('${b64}')
$err = [CredWriter]::Write('${KEYRING_TARGET}', $blob)
if ($err -ne 0) { [Console]::Error.WriteLine('CRED_WRITE_FAILED:' + $err); exit 4 }
[Console]::Out.Write('OK')
`.trim();

  const encoded = Buffer.from(ps, 'utf16le').toString('base64');
  execFileSync('powershell', ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded], {
    encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024,
  });
}

/**
 * Best-effort write-back of a rotated refresh_token. agy/Google may rotate the
 * refresh_token on each refresh; if we keep using the old one it eventually 401s
 * permanently (forcing a manual `agy login`). We read the current blob, swap ONLY
 * token.refresh_token, and persist — preserving every other field/format.
 * Returns true on success; never throws (the caller already has a valid access token).
 */
function saveRefreshToken(newRefreshToken) {
  if (!newRefreshToken) return false;
  try {
    if (process.platform === 'win32') {
      const blob = readWindowsKeyring();
      const tok = blob.token || blob;
      if (tok.refresh_token === newRefreshToken) return false; // unchanged → no write
      tok.refresh_token = newRefreshToken;
      writeWindowsKeyring(blob);
      return true;
    }
    const p = path.join(os.homedir(), '.gemini', 'oauth_creds.json');
    if (!fs.existsSync(p)) return false;
    const j = JSON.parse(fs.readFileSync(p, 'utf8'));
    if (j.refresh_token === newRefreshToken) return false;
    j.refresh_token = newRefreshToken;
    fs.writeFileSync(p, JSON.stringify(j), { encoding: 'utf8', mode: 0o600 });
    return true;
  } catch (_) {
    return false; // best-effort; refresh still succeeded with the new access token
  }
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

module.exports = { loadCredential, saveRefreshToken, KEYRING_TARGET };
