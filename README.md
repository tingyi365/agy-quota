# agy-quota

**[Antigravity](https://antigravity.google)（`agy` CLI）/ Google Gemini Code Assist 的 headless 額度查詢工具。**

直接從 Google 的 Code Assist 後端讀取你登入帳號的**真實**逐模型額度 —— 用的是 `agy` 本體自己呼叫的同一個端點 —— **不需要打開 Antigravity IDE、不需要 Windsurf/language-server 程序、也不需要任何本機 loopback API。** 輸出乾淨 JSON 給 agent/腳本用，或彩色表格給人看。

```
  Antigravity quota  (windows-keyring)
  you@gmail.com   plan: Gemini Code Assist in Google One AI Ultra

  gemini-2.5-flash       ████████████████████ 100.0%   ↻ 23h59m · 6/15 17:23
  gemini-2.5-pro         ████████████████████ 100.0%   ↻ 23h59m · 6/15 17:23
  gemini-3.1-flash-lite  ████████████████████ 100.0%   ↻ 23h59m · 6/15 17:23

  worst remaining: 100.0%   reset: ↻ 23h59m · 6/15 17:23
```

## 為什麼需要它

市面上多數 Antigravity 額度查詢工具都假設 IDE / language-server 正在跑、讀的是本機 API。如果你純 **headless** 驅動 `agy`（例如自動化裡跑 `agy -p "..."`、沒開 IDE），那些工具什麼都讀不到。

`agy-quota` 改走雲端路徑：取出 `agy` 存在**作業系統 keyring** 裡的 OAuth 憑證、刷新 access token、再查 Code Assist 額度端點。整個過程不需要 IDE 在跑 —— 最適合「派工前要先知道 Antigravity 還剩多少額度」的排程器。

## 安裝

需要 **Node.js ≥ 18**，以及一次互動式 `agy` 登入（讓憑證落進 keyring）。

```bash
git clone https://github.com/tingyi365/agy-quota.git
cd agy-quota
node bin/agy-quota.js          # 直接執行
# 或全域安裝：
npm install -g .
agy-quota
```

Windows 上也可直接呼叫內附的包裝檔：`agy-quota.cmd`。

## 用法

```
agy-quota [options]

  -j, --json        輸出乾淨 JSON（給 agent/腳本）
      --plain       關閉 ANSI 顏色
      --gate <pct>  最差剩餘 >= <pct>% 則 exit 0，否則 exit 10
  -h, --help        顯示說明
```

### `--json` 輸出

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

| 欄位 | 意義 |
|---|---|
| `remaining_fraction` | 所有模型中**最差（最小）**的剩餘比例，`0`–`1` —— 守門就用這個值 |
| `reset_time` | 所有模型中最早的額度重置時間（ISO 8601） |
| `plan` / `current_tier` | 帳號層級，來自 `loadCodeAssist` |
| `models[]` | 逐模型 bucket，含 `remaining_fraction` / `remaining_percent` / `reset_time` |
| `source` | 憑證來源（`windows-keyring` / `oauth_creds.json`） |

### Gate 模式（給排程器）

```bash
agy-quota --gate 15 --json || echo "額度過低 —— 改派別處"
# 最差剩餘 >= 15% 則 exit 0，否則 exit 10
```

## 運作原理

1. **憑證** —— Windows 上從認證管理員讀取 generic credential `gemini:antigravity`（UTF-8 JSON blob，走 `advapi32!CredRead`）。其他平台 fallback 到 `~/.gemini/oauth_creds.json`。
2. **刷新** —— 拿 `refresh_token` 到 `oauth2.googleapis.com/token` 換新的 `access_token`。OAuth client id/secret 是**執行時從你本機安裝的 `agy` 二進位撈出來的**（不寫死在本 repo），所以原始碼裡不夾帶任何 Google secret。配對成功的組合會快取在 temp 目錄。（可用 `AGY_BIN=/path/to/agy` 指定二進位位置。）
3. **額度** —— `POST https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota` 回傳逐模型的 `remainingFraction` + `resetTime`；`loadCodeAssist` 補上層級/帳號。（`daily-cloudcode-pa.googleapis.com` 這個別名也通。）

刷新後的 token 只在記憶體裡使用、**不會**寫回 keyring —— `agy` 自己會獨立維護它的 keyring token。

## 注意事項與限制

- **Windows 優先。** keyring 讀取器是針對 Windows 認證管理員實作的。macOS/Linux 在有 `oauth_creds.json` 時 fallback 用該檔。
- **重置週期看層級。** 免費層帳號普遍回報約 5 小時刷新一次；付費層（如 AI Ultra）回報每日重置。本工具如實回報 API 給的值 —— 信 `reset_time`，別信坊間傳說。
- 需要一個有效的已登入 `agy` session。若憑證不存在，先用 `agy` 互動登入一次。

## 致謝 / 既有作品

headless **雲端路徑**（keyring → token 刷新 → Code Assist 額度）參考了既有的 Antigravity 額度查詢工具 —— 特別是 [skainguyen1412/antigravity-usage](https://github.com/skainguyen1412/antigravity-usage)（cloud-mode fallback）與 `gemini-cli-hud` extension 的額度模組（`loadCodeAssist`）。本專案的貢獻是一份乾淨、零相依、**Windows keyring** 的實作，附 agent 友善的 JSON 與 `--gate` 模式。

## 授權

[MIT](./LICENSE)

---

<a name="english"></a>

# agy-quota (English)

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
