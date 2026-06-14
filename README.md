# agy-quota

**Headless usage-quota checker for [Antigravity](https://antigravity.google) (the `agy` CLI) / Google Gemini Code Assist.**

Reads your logged-in account's *real* per-model quota directly from Google's
Code Assist backend — the same endpoint the `agy` binary itself calls — **without
opening the Antigravity IDE, a Windsurf/language-server process, or any local
loopback API.** Outputs clean JSON for agents/scripts or a colored table for humans.

```
  Antigravity quota  (windows-keyring)
  you@gmail.com   plan: Gemini Code Assist in Google One AI Ultra

  gemini-2.5-flash       ████████████████████ 100.0%   ↻ 23h59m · 6/15 17:23
  gemini-2.5-pro         ████████████████████ 100.0%   ↻ 23h59m · 6/15 17:23
  gemini-3.1-flash-lite  ████████████████████ 100.0%   ↻ 23h59m · 6/15 17:23

  worst remaining: 100.0%   reset: ↻ 23h59m · 6/15 17:23
```

## Why

Most existing Antigravity usage checkers assume the IDE / language-server is
running and read a local API. If you drive `agy` purely **headlessly** (e.g.
`agy -p "..."` from automation, no IDE open), those tools find nothing.

`agy-quota` takes the cloud path instead: it pulls the OAuth credential `agy`
stored in the **OS keyring**, refreshes the access token, and queries the Code
Assist quota endpoint. This works with no IDE running — ideal for schedulers
that need to know "how much Antigravity quota is left before I dispatch a job".

## Install

Requires **Node.js ≥ 18** and a one-time interactive `agy` login (so the
credential exists in the keyring).

```bash
git clone https://github.com/tingyi365/agy-quota.git
cd agy-quota
node bin/agy-quota.js          # run directly
# or install globally:
npm install -g .
agy-quota
```

On Windows you can also just call the bundled wrapper: `agy-quota.cmd`.

## Usage

```
agy-quota [options]

  -j, --json        Emit clean JSON (for agents/scripts)
      --plain       Disable ANSI colors
      --gate <pct>  Exit 0 if worst remaining >= <pct>%, else exit 10
  -h, --help        Show help
```

### `--json` output

```json
{
  "account": "you@gmail.com",
  "plan": "Gemini Code Assist in Google One AI Ultra",
  "current_tier": "Gemini Code Assist",
  "remaining_fraction": 1,
  "reset_time": "2026-06-15T09:22:52Z",
  "models": [
    { "model_id": "gemini-2.5-pro", "token_type": "REQUESTS",
      "remaining_fraction": 1, "remaining_percent": 100,
      "reset_time": "2026-06-15T09:22:52Z" }
  ],
  "source": "windows-keyring",
  "fetched_at": "2026-06-14T09:22:53.683Z"
}
```

| field | meaning |
|---|---|
| `remaining_fraction` | worst (minimum) remaining fraction across all models, `0`–`1` — the value to gate on |
| `reset_time` | earliest quota reset across models (ISO 8601) |
| `plan` / `current_tier` | account tier from `loadCodeAssist` |
| `models[]` | per-model buckets with `remaining_fraction` / `remaining_percent` / `reset_time` |
| `source` | where the credential came from (`windows-keyring` / `oauth_creds.json`) |

### Gate mode (for schedulers)

```bash
agy-quota --gate 15 --json || echo "low quota — route elsewhere"
# exit 0 if worst remaining >= 15%, else exit 10
```

## How it works

1. **Credential** — on Windows, read the generic credential `gemini:antigravity`
   from Credential Manager (UTF-8 JSON blob via `advapi32!CredRead`). On other
   platforms, fall back to `~/.gemini/oauth_creds.json`.
2. **Refresh** — exchange the `refresh_token` for a fresh `access_token` at
   `oauth2.googleapis.com/token`. The OAuth client id/secret are **discovered at
   runtime from your locally installed `agy` binary** (not hard-coded in this
   repo), so no Google secret ships in the source. The working pair is cached in
   your temp dir. (Override binary location with `AGY_BIN=/path/to/agy`.)
3. **Quota** — `POST https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota`
   returns per-model `remainingFraction` + `resetTime`; `loadCodeAssist` adds the
   tier/account. (The `daily-cloudcode-pa.googleapis.com` alias works too.)

The refreshed token is used in-memory only and **not** written back — `agy`
maintains its own keyring token independently.

## Notes & limitations

- **Windows-first.** The keyring reader is implemented for Windows Credential
  Manager. macOS/Linux fall back to the `oauth_creds.json` file if present.
- **Reset cadence depends on tier.** Free-tier accounts are widely reported to
  refresh on a ~5h window; paid tiers (e.g. AI Ultra) report a daily reset.
  The tool reports whatever the API returns — trust `reset_time`, not folklore.
- Requires a valid logged-in `agy` session. If the credential is missing, log in
  once interactively with `agy`.

## Credits / prior art

The headless **cloud path** (keyring → token refresh → Code Assist quota) is
inspired by prior Antigravity usage checkers — notably
[skainguyen1412/antigravity-usage](https://github.com/skainguyen1412/antigravity-usage)
(cloud-mode fallback) and the `gemini-cli-hud` extension's quota module
(`loadCodeAssist`). This project's contribution is a clean, dependency-free,
**Windows keyring** implementation with agent-friendly JSON and a `--gate` mode.

## License

[MIT](./LICENSE)
