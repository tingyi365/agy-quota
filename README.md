# agy-quota

**[Antigravity](https://antigravity.google)（`agy` CLI）/ Google Gemini Code Assist 的 headless 額度查詢工具。**

直接從 Google 的 Code Assist 後端讀取你登入帳號的**真實**逐模型額度 —— 用的是 `agy` 本體自己呼叫的同一個端點 —— **不需要打開 Antigravity IDE、不需要 Windsurf/language-server 程序、也不需要任何本機 loopback API。** 輸出乾淨 JSON 給 agent/腳本用，或彩色表格給人看。

同捆的 **[`agy-run`](#agy-run--用-antigravity-額度-headless-跑任務)** 更進一步：走同一條雲端路徑 headless **跑任務**（把 prompt 丟給 Antigravity 的生成端點），讓排程器用 Antigravity 的免費額度分擔工作。支援 Antigravity 後端代理的**全部模型**——Gemini 全系列、**Claude Opus 4.6 / Sonnet 4.6**、**GPT-OSS 120B**——全部走同一個端點、依 model id 自動路由。

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

## `agy-run` —— 用 Antigravity 額度 headless 跑任務

同一條雲端路徑不只能查額度，還能**直接跑任務**，而且**不限 Gemini**——Antigravity 後端會把 Claude 與 GPT-OSS 也代理在同一個端點上。`agy-run` 把一個 prompt 丟給 `agy` 本體實際呼叫的生成端點（`v1internal:generateContent`），純 HTTPS、無需 IDE / language-server / TTY，拿回模型回應文字與 token 用量。**依 model id 自動路由**：填 `claude-opus-4-6-thinking` 就跑 Claude Opus、填 `gpt-oss-120b-medium` 就跑 GPT-OSS，呼叫方式完全一樣。

> 為什麼不用 `agy --print`？因為 `agy` CLI 是互動式 console 程式，在**無 TTY** 環境（自動化、排程器、CI）一律掛死、零輸出、也不扣額度。`agy-run` 直打 HTTP API 繞過這個限制。

```
agy-run [options] "你的 prompt"
echo "你的 prompt" | agy-run [options]

  -j, --json            輸出乾淨 JSON（回應文字 + token 用量）
  -l, --list-models     列出全部可呼叫模型（Gemini + Claude + GPT-OSS）+ 剩餘額度
  -m, --model <id>      模型 id（預設 gemini-2.5-pro）
  -s, --system <text>   system instruction
  -t, --temperature <n> 取樣溫度
      --max-tokens <n>  輸出 token 上限
      --project <id>    覆寫 cloudaicompanionProject
      --timeout <sec>   單次請求逾時秒數（預設 120）
  -h, --help            顯示說明
```

**給 agent 調用的那一行（Gemini）：**

```bash
node bin/agy-run.js --json -m gemini-3-flash "你的任務 prompt"
# 或全域安裝後： agy-run --json -m gemini-3-flash "..."
```

**跑 Claude Opus 4.6（注意 id 帶 `-thinking` 後綴）：**

```bash
node bin/agy-run.js --json -m claude-opus-4-6-thinking "你的任務 prompt"
node bin/agy-run.js --json -m claude-sonnet-4-6        "你的任務 prompt"
```

**跑 GPT-OSS 120B：**

```bash
node bin/agy-run.js --json -m gpt-oss-120b-medium "你的任務 prompt"
```

JSON 輸出（新增 `provider` 欄位）：

```json
{
  "model": "claude-opus-4-6-thinking",
  "provider": "anthropic",
  "model_version": "claude-opus-4-6-thinking",
  "text": "模型的回應文字…",
  "finish_reason": "STOP",
  "usage": { "prompt_tokens": 21, "candidates_tokens": 6, "total_tokens": 27 },
  "project": "reverberant-sprite-xxxxx",
  "response_id": "…",
  "source": "windows-keyring",
  "fetched_at": "2026-06-14T11:30:43.391Z"
}
```

### 可用模型

跑 `agy-run --list-models`（加 `--json` 給腳本）拿即時清單 + 逐模型剩餘額度。下表為實測結果（✅ = 實際跑過一個 prompt 拿到正常回應）：

| model id | provider | 狀態 |
|---|---|---|
| `claude-opus-4-6-thinking` | anthropic | ✅ Claude Opus 4.6（思考版） |
| `claude-sonnet-4-6` | anthropic | ✅ Claude Sonnet 4.6 |
| `gpt-oss-120b-medium` | openai | ✅ GPT-OSS 120B |
| `gemini-3-flash` · `gemini-3-flash-agent` | google | ✅ |
| `gemini-3.1-pro-low` · `gemini-pro-agent` | google | ✅ Gemini 3.1 Pro 級 |
| `gemini-3.5-flash-low` · `gemini-3.5-flash-extra-low` | google | ✅ |
| `gemini-3.1-flash-lite` · `gemini-3.1-flash-image` | google | ✅ |
| `gemini-2.5-flash` · `gemini-2.5-flash-lite` · `gemini-2.5-flash-thinking` | google | ✅ |
| `gemini-2.5-pro` | google | ⚠️ 後端常回 503「No capacity」（暫時無容量，非本工具問題；改用 `gemini-3-flash`） |
| `gemini-3.1-pro-high` | google | ⚠️ 後端回 400 `INVALID_ARGUMENT`（此別名目前被拒；同級改用 `gemini-3.1-pro-low` 或 `gemini-pro-agent`） |

請求會消耗該帳號的**真實額度**——短期額度耗盡時端點會回 HTTP 429 `RESOURCE_EXHAUSTED`。

> **關鍵：非 Gemini 模型需要 Antigravity 識別 header。** Claude 與 GPT-OSS 只有在請求帶上 `Client-Metadata: {"ideType":"ANTIGRAVITY"}`（外加 Antigravity 版本的 User-Agent）時才放行；少了它後端一律回 `404 NOT_FOUND`。`agy-run` 已自動對每次生成請求帶上這組 header，Gemini 帶著也無妨。

## 運作原理

1. **憑證** —— Windows 上從認證管理員讀取 generic credential `gemini:antigravity`（UTF-8 JSON blob，走 `advapi32!CredRead`）。其他平台 fallback 到 `~/.gemini/oauth_creds.json`。
2. **刷新** —— 拿 `refresh_token` 到 `oauth2.googleapis.com/token` 換新的 `access_token`。OAuth client id/secret 是**執行時從你本機安裝的 `agy` 二進位撈出來的**（不寫死在本 repo），所以原始碼裡不夾帶任何 Google secret。配對成功的組合會快取在 temp 目錄。（可用 `AGY_BIN=/path/to/agy` 指定二進位位置。）
3. **額度** —— `POST https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota` 回傳逐模型的 `remainingFraction` + `resetTime`；`loadCodeAssist` 補上層級/帳號。（`daily-cloudcode-pa.googleapis.com` 這個別名也通。）
4. **跑任務（`agy-run`）** —— 同一個 host 的 `POST .../v1internal:generateContent`，payload 為 `{ model, project, request }`，其中 `project` 取自 `loadCodeAssist` 的 `cloudaicompanionProject`、`request` 是標準 Gemini `GenerateContentRequest`（`contents` / `systemInstruction` / `generationConfig`）。回應外層為 `{ response: {...} }`，文字在 `response.candidates[0].content.parts[].text`、用量在 `response.usageMetadata`。
5. **多 provider 路由** —— Claude 與 GPT-OSS **走的是同一個端點、同一種 payload、同一種回應格式**：Antigravity 後端在內部把它們轉成 Gemini 風格（對應 `agy` 二進位裡的 `anthropicConverter` / `openaiConverter`），客戶端只要填對 `model` 字串即可，不需要不同 host 或不同 path。唯一差別是非 Gemini 模型**必須**帶 `Client-Metadata: {"ideType":"ANTIGRAVITY"}` 這組識別 header 才放行（否則 `404 NOT_FOUND`）；合法 model id 的權威來源是 `POST .../v1internal:fetchAvailableModels`（即 `agy-run --list-models` 背後打的端點）。

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

The bundled **[`agy-run`](#agy-run--run-tasks-headlessly-on-the-antigravity-quota)**
goes one step further: it *runs tasks* headlessly over the same cloud path (sending
a prompt to Antigravity's generative endpoint), letting a scheduler offload work
onto the Antigravity free quota. It supports **every model the Antigravity backend
proxies** — the full Gemini line-up, **Claude Opus 4.6 / Sonnet 4.6**, and
**GPT-OSS 120B** — all through the same endpoint, routed automatically by model id.

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

## `agy-run` — run tasks headlessly on the Antigravity quota

The same cloud path can do more than *check* quota — it can *run work*, and **not
just on Gemini**: the Antigravity backend proxies Claude and GPT-OSS through the
exact same endpoint. `agy-run` sends a prompt to the very generative endpoint the
`agy` binary itself calls (`v1internal:generateContent`) over plain HTTPS — no IDE,
language-server, or TTY required — and returns the model's text plus token usage.
It **routes by model id**: pass `claude-opus-4-6-thinking` to run Claude Opus, or
`gpt-oss-120b-medium` to run GPT-OSS — the call site is identical.

> Why not `agy --print`? Because the `agy` CLI is an interactive console program
> that **hangs with zero output (and consumes no quota) in any non-TTY
> environment** (automation, schedulers, CI). `agy-run` calls the HTTP API
> directly to sidestep that.

```
agy-run [options] "your prompt"
echo "your prompt" | agy-run [options]

  -j, --json            Emit clean JSON (response text + token usage)
  -l, --list-models     List every callable model (Gemini + Claude + GPT-OSS) + quota
  -m, --model <id>      Model id (default gemini-2.5-pro)
  -s, --system <text>   System instruction
  -t, --temperature <n> Sampling temperature
      --max-tokens <n>  Max output tokens
      --project <id>    Override cloudaicompanionProject
      --timeout <sec>   Per-request timeout in seconds (default 120)
  -h, --help            Show help
```

**The one line an agent calls (Gemini):**

```bash
node bin/agy-run.js --json -m gemini-3-flash "your task prompt"
# or, after global install: agy-run --json -m gemini-3-flash "..."
```

**Run Claude Opus 4.6 (note the `-thinking` suffix in the id):**

```bash
node bin/agy-run.js --json -m claude-opus-4-6-thinking "your task prompt"
node bin/agy-run.js --json -m claude-sonnet-4-6        "your task prompt"
```

**Run GPT-OSS 120B:**

```bash
node bin/agy-run.js --json -m gpt-oss-120b-medium "your task prompt"
```

JSON output (now with a `provider` field):

```json
{
  "model": "claude-opus-4-6-thinking",
  "provider": "anthropic",
  "model_version": "claude-opus-4-6-thinking",
  "text": "the model's reply…",
  "finish_reason": "STOP",
  "usage": { "prompt_tokens": 21, "candidates_tokens": 6, "total_tokens": 27 },
  "project": "reverberant-sprite-xxxxx",
  "response_id": "…",
  "source": "windows-keyring",
  "fetched_at": "2026-06-14T11:30:43.391Z"
}
```

### Available models

Run `agy-run --list-models` (add `--json` for scripts) for the live list plus
per-model remaining quota. The table below is empirically verified (✅ = actually
ran a prompt and got a normal reply):

| model id | provider | status |
|---|---|---|
| `claude-opus-4-6-thinking` | anthropic | ✅ Claude Opus 4.6 (Thinking) |
| `claude-sonnet-4-6` | anthropic | ✅ Claude Sonnet 4.6 |
| `gpt-oss-120b-medium` | openai | ✅ GPT-OSS 120B |
| `gemini-3-flash` · `gemini-3-flash-agent` | google | ✅ |
| `gemini-3.1-pro-low` · `gemini-pro-agent` | google | ✅ Gemini 3.1 Pro class |
| `gemini-3.5-flash-low` · `gemini-3.5-flash-extra-low` | google | ✅ |
| `gemini-3.1-flash-lite` · `gemini-3.1-flash-image` | google | ✅ |
| `gemini-2.5-flash` · `gemini-2.5-flash-lite` · `gemini-2.5-flash-thinking` | google | ✅ |
| `gemini-2.5-pro` | google | ⚠️ backend often returns 503 "No capacity" (transient, server-side; use `gemini-3-flash`) |
| `gemini-3.1-pro-high` | google | ⚠️ backend returns 400 `INVALID_ARGUMENT` (this alias is currently rejected; use `gemini-3.1-pro-low` / `gemini-pro-agent`) |

Requests consume the account's **real quota** — when short-term capacity is
exhausted the endpoint returns HTTP 429 `RESOURCE_EXHAUSTED`.

> **Key: non-Gemini models require an Antigravity identity header.** Claude and
> GPT-OSS are only served when the request carries `Client-Metadata:
> {"ideType":"ANTIGRAVITY"}` (plus an Antigravity-flavored User-Agent); without it
> the backend answers `404 NOT_FOUND`. `agy-run` attaches this header to every
> generative request automatically (harmless for Gemini).

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
4. **Run (`agy-run`)** — `POST .../v1internal:generateContent` on the same host,
   with payload `{ model, project, request }` — `project` comes from
   `loadCodeAssist`'s `cloudaicompanionProject`, and `request` is a standard Gemini
   `GenerateContentRequest` (`contents` / `systemInstruction` / `generationConfig`).
   The reply is wrapped as `{ response: {...} }`; text lives at
   `response.candidates[0].content.parts[].text` and usage at `response.usageMetadata`.
5. **Multi-provider routing** — Claude and GPT-OSS use the **same endpoint, same
   payload, and same response shape**: the Antigravity backend converts them to
   Gemini style internally (the `anthropicConverter` / `openaiConverter` you can
   spot in the `agy` binary), so the client only needs the right `model` string —
   no separate host or path. The one catch: non-Gemini models **require** the
   `Client-Metadata: {"ideType":"ANTIGRAVITY"}` identity header or the backend
   returns `404 NOT_FOUND`. The authoritative source of valid model ids is
   `POST .../v1internal:fetchAvailableModels` — exactly what `agy-run --list-models`
   calls under the hood.

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
