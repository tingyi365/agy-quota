# agy-quota

**[Antigravity](https://antigravity.google)（`agy` CLI）/ Google Gemini Code Assist 的 headless 額度查詢工具。**

直接從 Google 的 Code Assist 後端讀取你登入帳號的**真實**額度 —— 用的是 `agy` 本體自己呼叫的同一個端點 —— **不需要打開 Antigravity IDE、不需要 Windsurf/language-server 程序、也不需要任何本機 loopback API。** 涵蓋**全部可呼叫模型**（Gemini 全系列、Claude、GPT-OSS），依 provider 分組。輸出乾淨 JSON 給 agent/腳本用，或彩色表格給人看，並提供 `--gate` 守門模式給排程器。

> Gemini 用每帳號權威的 **REQUESTS 桶**；Claude/GPT 沒有那種桶，改用 `fetchAvailableModels` 的**池剩餘比例**（真實會隨用量下降，但**以 provider 池為單位共用**，非單一模型精準額度）。細節見〈[全模型額度池](#全模型額度池為何-claudegpt-與-gemini-來源不同)〉。

> 🔗 **想用這條雲端路徑「跑任務」而不只是查額度？** 姊妹專案 **[agy-run](https://github.com/tingyi365/agy-run)** 把 Claude Code（與任何 Anthropic 客戶端）橋接到 Antigravity 的免費 Opus 額度，並附 headless prompt runner。`agy-quota` 專心做「查」，`agy-run` 專心做「跑」，兩者可組成「查額度 → 守門 → 跑任務」的閉環。

```
  Antigravity quota  (windows-keyring)
  you@gmail.com   plan: Gemini Code Assist in Google One AI Ultra

  ANTHROPIC  shared Vertex pool — one meter for ALL Anthropic+OpenAI models
  claude-opus-4-6-thinking    ████████████████████ 99.5%   ↻ 3h58m
  claude-sonnet-4-6           ████████████████████ 99.5%   ↻ 3h58m

  OPENAI  shared Vertex pool — one meter for ALL Anthropic+OpenAI models
  gpt-oss-120b-medium         ████████████████████ 99.5%   ↻ 3h58m

  GOOGLE  shared Google pool (token-weighted)
  gemini-2.5-pro              ████████████████████ 99.7%   ↻ 1h49m
  … (全部 gemini-*) …

  GOOGLE · REQUESTS buckets  retrieveUserQuota · authoritative per-account meter
  gemini-2.5-pro         ████████████████████ 100.0%  ↻ 24h0m

  worst remaining (all pools): 99.5%
  gemini-bucket worst: 100.0%  ·  reset 24h0m
```

## 為什麼需要它

市面上多數 Antigravity 額度查詢工具都假設 IDE / language-server 正在跑、讀的是本機 API。如果你純 **headless** 驅動 `agy`（例如自動化裡跑 `agy -p "..."`、沒開 IDE），那些工具什麼都讀不到。

`agy-quota` 改走雲端路徑：取出 `agy` 存在**作業系統 keyring** 裡的 OAuth 憑證、刷新 access token、再查 Code Assist 額度端點。整個過程不需要 IDE 在跑 —— 最適合「派工前要先知道 Antigravity 還剩多少額度」的排程器。

## 安裝

需要 **Node.js ≥ 18**，以及一次互動式 `agy` 登入（讓憑證落進 keyring）。零 npm 相依。

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

  -j, --json            輸出乾淨 JSON（給 agent/腳本）
      --plain           關閉 ANSI 顏色
      --gate <pct>      最差剩餘 >= <pct>% 則 exit 0，否則 exit 10
      --gate-scope <s>  守門範圍：google（預設，gemini REQUESTS 桶）或
                        all（橫跨全部 provider 池取最差）
  -h, --help            顯示說明
```

### `--json` 輸出

```json
{
  "account": "you@gmail.com",
  "plan": "Gemini Code Assist in Google One AI Ultra",
  "current_tier": "Gemini Code Assist",
  "remaining_fraction": 1,
  "reset_time": "2026-06-15T13:59:03Z",
  "models": [
    { "model_id": "gemini-2.5-pro", "token_type": "REQUESTS",
      "remaining_fraction": 1, "remaining_percent": 100,
      "reset_time": "2026-06-15T13:59:03Z" }
  ],
  "providers": [
    {
      "provider": "ANTHROPIC",
      "quota_scope": "vertex_pool_shared",
      "note": "Anthropic and OpenAI models share ONE Vertex quota pool together …",
      "quota_source": "fetchAvailableModels",
      "pool_remaining_fraction": 0.99529743,
      "pool_remaining_percent": 99.5,
      "pool_reset_time": "2026-06-14T18:03:02Z",
      "models": [
        { "model_id": "claude-opus-4-6-thinking", "token_type": "POOL_FRACTION",
          "remaining_fraction": 0.99529743, "remaining_percent": 99.5,
          "reset_time": "2026-06-14T18:03:02Z" },
        { "model_id": "claude-sonnet-4-6", "token_type": "POOL_FRACTION",
          "remaining_fraction": 0.99529743, "remaining_percent": 99.5,
          "reset_time": "2026-06-14T18:03:02Z" }
      ]
    },
    { "provider": "OPENAI", "quota_scope": "vertex_pool_shared",
      "pool_remaining_percent": 99.5, "models": [ "…gpt-oss-120b-medium…" ] },
    { "provider": "GOOGLE", "quota_scope": "google_pool",
      "pool_remaining_percent": 99.7, "models": [ "…全部 gemini-* …" ] }
  ],
  "providers_error": null,
  "remaining_fraction_all_pools": 0.99529743,
  "remaining_percent_all_pools": 99.5,
  "source": "windows-keyring",
  "fetched_at": "2026-06-14T13:59:05.333Z"
}
```

| 欄位 | 意義 |
|---|---|
| `remaining_fraction` | **（相容欄位，語意不變）** gemini REQUESTS 桶中最差的剩餘比例，`0`–`1` |
| `reset_time` | gemini REQUESTS 桶中最早的重置時間（ISO 8601） |
| `models[]` | **（相容欄位）** gemini REQUESTS 桶（`retrieveUserQuota`，每帳號權威數字） |
| `providers[]` | 全部可呼叫模型，依 provider 分組（`ANTHROPIC` / `OPENAI` / `GOOGLE`）。每個模型列 `model_id` / `remaining_percent` / `remaining_fraction` / `token_type` / `reset_time`；組層級另有 `pool_remaining_percent`、`pool_reset_time`、`quota_scope`、`note` |
| `remaining_*_all_pools` | 橫跨 gemini 桶＋全部 provider 池的最差剩餘 —— 想守門到 Claude/GPT 就用這個 |
| `providers_error` | `fetchAvailableModels` 若失敗的錯誤訊息（否則 `null`；不影響相容欄位） |
| `plan` / `current_tier` | 帳號層級，來自 `loadCodeAssist` |
| `source` | 憑證來源（`windows-keyring` / `oauth_creds.json`） |

> ⚠️ **`providers[]` 的 `token_type` 是 `POOL_FRACTION`，不是精準的逐模型額度。** 見下節〈全模型額度池〉的實證。

### Gate 模式（給排程器）

```bash
agy-quota --gate 15 --json || echo "額度過低 —— 改派別處"
# 最差剩餘 >= 15% 則 exit 0，否則 exit 10

# 想把 Claude/GPT 也納入守門（gemini 桶在 AI Ultra 上常年 100%）：
agy-quota --gate 15 --gate-scope all --json || echo "某個 provider 池過低"
```

## 全模型額度池（為何 Claude/GPT 與 gemini 來源不同）

舊版只報 `retrieveUserQuota` 回的 **4 個 gemini REQUESTS 桶**；Claude / GPT-OSS 根本不在那個端點裡。要看非 Google 模型的剩餘額度，唯一來源是 `fetchAvailableModels`（即查全模型清單背後的端點）回的 `quotaInfo.remainingFraction`。本版把它接進 `providers[]`。

**但這個數字的「顆粒度」我們實際逆向驗證過，誠實寫在這裡，不誇大成「精準逐模型額度」：**

實驗方法：先快照各模型的 `q`，對單一模型連發 N 個請求消耗，再快照看哪些模型的 `q` 下降。

| 動作 | gemini-2.5-flash `q` | gemini-3-flash `q` | claude-sonnet-4-6 `q` | gpt-oss-120b `q` | 結論 |
|---|---|---|---|---|---|
| 燒 6 個 **gpt-oss** 小請求 | 不動 | 不動 | **−0.0000030** | **−0.0000030** | Claude 與 GPT **同步等量**下降、gemini 不動 |
| 燒 8 個 **gemini-3-flash** 重請求 | **−0.0000178** | **−0.0000178** | 不動 | 不動 | 全部 gemini **同步等量**下降、Claude/GPT 不動 |
| 燒 6 個 **gemini** 小請求 | 不動 | 不動 | 不動 | 不動 | gemini 池是 **token 加權**，小請求低於可表示顆粒度 |

**據此可以下的結論：**

1. **`q` 是真實消耗量，不是「可用 / 不可用」旗標。** 它會隨用量單調下降、且與用量成比例（重請求降得多、瑣碎請求幾乎不降）。
2. **但 `q` 是「整池共用」，不是逐模型私有額度。** 全部 gemini 共用**一個 Google 池**；全部 Anthropic **與** OpenAI 模型**共用同一個 Vertex 池**（燒一個 gpt-oss 請求，Claude 的 `q` 會等量下降）。所以你**無法**從 `q` 讀出某單一模型自己的剩餘額度 —— 只能讀到它所屬池的剩餘。這就是欄位標 `token_type: POOL_FRACTION` 的原因。
3. **gemini 有兩套帳。** `providers[].GOOGLE` 的池是 token 加權、約數小時的滾動視窗；而 `retrieveUserQuota` 的 **REQUESTS 桶**（`models[]`）是另一套、按請求數計、付費層每日重置 —— 後者才是每帳號的**權威** gemini 數字，故保留在相容欄位裡。

簡言之：**gemini 用權威的 REQUESTS 桶；Claude/GPT 沒有那種桶，只能用 `fetchAvailableModels` 的「池剩餘比例」近似** —— 它是真實、會隨用量下降的池水位，但**以 provider 池為單位共用，並非單一模型的精準額度**。

## 運作原理

1. **憑證** —— Windows 上從認證管理員讀取 generic credential `gemini:antigravity`（UTF-8 JSON blob，走 `advapi32!CredRead`）。其他平台 fallback 到 `~/.gemini/oauth_creds.json`。
2. **刷新** —— 拿 `refresh_token` 到 `oauth2.googleapis.com/token` 換新的 `access_token`。OAuth client id/secret 是**執行時從你本機安裝的 `agy` 二進位撈出來的**（不寫死在本 repo），所以原始碼裡不夾帶任何 Google secret。配對成功的組合會快取在 temp 目錄。（可用 `AGY_BIN=/path/to/agy` 指定二進位位置。）
3. **額度** —— `POST https://cloudcode-pa.googleapis.com/v1internal:retrieveUserQuota` 回傳逐模型的 `remainingFraction` + `resetTime`；`loadCodeAssist` 補上層級/帳號；`fetchAvailableModels` 補上非 Google 模型的池剩餘。（`daily-cloudcode-pa.googleapis.com` 這個別名也通。）

刷新後的 token 只在記憶體裡使用 —— `agy` 自己會獨立維護它的 keyring token（本工具僅在偵測到 refresh_token 輪替時，盡力把新值寫回，避免舊 token 失效逼你重登）。

## 注意事項與限制

- **Windows 優先。** keyring 讀取器是針對 Windows 認證管理員實作的。macOS/Linux 在有 `oauth_creds.json` 時 fallback 用該檔。
- **重置週期看層級。** 免費層帳號普遍回報約 5 小時刷新一次；付費層（如 AI Ultra）回報每日重置。本工具如實回報 API 給的值 —— 信 `reset_time`，別信坊間傳說。
- 需要一個有效的已登入 `agy` session。若憑證不存在，先用 `agy` 互動登入一次。
- 本工具與 Google / Antigravity 無任何隸屬關係。

## 致謝 / 既有作品

headless **雲端路徑**（keyring → token 刷新 → Code Assist 額度）參考了既有的 Antigravity 額度查詢工具 —— 特別是 [skainguyen1412/antigravity-usage](https://github.com/skainguyen1412/antigravity-usage)（cloud-mode fallback）與 `gemini-cli-hud` extension 的額度模組（`loadCodeAssist`）。本專案的貢獻是一份乾淨、零相依、**Windows keyring** 的實作，附 agent 友善的 JSON 與 `--gate` 模式。

## 授權

[MIT](./LICENSE)

---

<a name="english"></a>

# agy-quota (English)

**Headless usage-quota checker for [Antigravity](https://antigravity.google) (the `agy` CLI) / Google Gemini Code Assist.**

Reads your logged-in account's *real* quota directly from Google's
Code Assist backend — the same endpoint the `agy` binary itself calls — **without
opening the Antigravity IDE, a Windsurf/language-server process, or any local
loopback API.** Covers **every callable model** (the whole Gemini line-up, Claude,
GPT-OSS), grouped by provider. Outputs clean JSON for agents/scripts or a colored
table for humans, with a `--gate` mode for schedulers.

> Gemini uses its authoritative per-account **REQUESTS buckets**; Claude/GPT have
> no such bucket, so they fall back to the **pool remaining fraction** from
> `fetchAvailableModels` (a real meter that drops as you spend, but **shared
> per provider pool** — not a precise single-model budget). See
> [All-model quota pool](#all-model-quota-pool-why-claudegpt-differ-from-gemini).

> 🔗 **Want to *run tasks* on this cloud path, not just check quota?** The sister
> project **[agy-run](https://github.com/tingyi365/agy-run)** bridges Claude Code
> (and any Anthropic client) onto the Antigravity free Opus quota and ships a
> headless prompt runner. `agy-quota` does the *checking*, `agy-run` does the
> *running* — together they form a "check quota → gate → run task" loop.

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
credential exists in the keyring). No npm dependencies.

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

  -j, --json            Emit clean JSON (for agents/scripts)
      --plain           Disable ANSI colors
      --gate <pct>      Exit 0 if worst remaining >= <pct>%, else exit 10
      --gate-scope <s>  Gate scope: google (default, gemini REQUESTS buckets) or
                        all (worst across every provider pool)
  -h, --help            Show help
```

### `--json` output

The same object shown in the Chinese section above: top-level legacy fields
(`remaining_fraction`, `reset_time`, `models[]` = the authoritative gemini
REQUESTS buckets) plus an additive `providers[]` array (every callable model
grouped `ANTHROPIC` / `OPENAI` / `GOOGLE`, each with pooled `remaining_percent` /
`token_type` / `reset_time`) and `remaining_*_all_pools` for cross-pool gating.

| field | meaning |
|---|---|
| `remaining_fraction` | **(legacy, unchanged)** worst remaining fraction across the gemini REQUESTS buckets, `0`–`1` |
| `reset_time` | earliest reset across the gemini REQUESTS buckets (ISO 8601) |
| `models[]` | **(legacy)** gemini REQUESTS buckets (`retrieveUserQuota`, the authoritative per-account meter) |
| `providers[]` | every callable model grouped by provider; each model lists `model_id` / `remaining_percent` / `remaining_fraction` / `token_type` / `reset_time`; the group also carries `pool_remaining_percent`, `pool_reset_time`, `quota_scope`, `note` |
| `remaining_*_all_pools` | worst remaining across the gemini buckets **plus** every provider pool — gate on this to cover Claude/GPT |
| `providers_error` | error string if `fetchAvailableModels` failed (else `null`; never affects legacy fields) |
| `plan` / `current_tier` | account tier from `loadCodeAssist` |
| `source` | where the credential came from (`windows-keyring` / `oauth_creds.json`) |

> ⚠️ **`providers[]` rows carry `token_type: POOL_FRACTION`, not a precise per-model budget.** See the empirically verified [All-model quota pool](#all-model-quota-pool-why-claudegpt-differ-from-gemini) section.

### Gate mode (for schedulers)

```bash
agy-quota --gate 15 --json || echo "low quota — route elsewhere"
# exit 0 if worst remaining >= 15%, else exit 10

# Include Claude/GPT in the gate (gemini buckets sit at 100% on AI Ultra):
agy-quota --gate 15 --gate-scope all --json || echo "a provider pool is low"
```

## All-model quota pool (why Claude/GPT differ from Gemini)

The old output only reported the **4 gemini REQUESTS buckets** from
`retrieveUserQuota`; Claude / GPT-OSS aren't in that endpoint at all. The only
source for non-Google models' remaining quota is the
`quotaInfo.remainingFraction` returned by `fetchAvailableModels`. This version
wires it into `providers[]`.

**But we empirically reverse-verified the *granularity* of that number and
report it honestly here — we do NOT inflate it into "precise per-model quota":**

Method: snapshot each model's `q`, burn N requests on one model, re-snapshot,
see whose `q` dropped.

| action | gemini-2.5-flash `q` | gemini-3-flash `q` | claude-sonnet-4-6 `q` | gpt-oss-120b `q` | finding |
|---|---|---|---|---|---|
| burn 6 small **gpt-oss** reqs | flat | flat | **−0.0000030** | **−0.0000030** | Claude and GPT drop **together, equally**; gemini untouched |
| burn 8 heavy **gemini-3-flash** reqs | **−0.0000178** | **−0.0000178** | flat | flat | all gemini drop **together, equally**; Claude/GPT untouched |
| burn 6 small **gemini** reqs | flat | flat | flat | flat | the gemini pool is **token-weighted**; tiny reqs are below representable granularity |

**What this licenses us to conclude:**

1. **`q` is a real consumption meter, not an availability flag.** It decreases
   monotonically with use, proportional to spend (heavy reqs move it a lot,
   trivial reqs barely at all).
2. **But `q` is *pooled*, not a private per-model budget.** All Gemini models
   share **one Google pool**; all Anthropic **and** OpenAI models share **one
   Vertex pool together** (burn a gpt-oss request and Claude's `q` drops by the
   same amount). You therefore **cannot** read an individual model's own
   remaining budget from `q` — only its pool's. That's exactly why the field is
   labeled `token_type: POOL_FRACTION`.
3. **Gemini is metered twice.** The `providers[].GOOGLE` pool is token-weighted
   on a ~few-hour rolling window, whereas `retrieveUserQuota`'s **REQUESTS
   buckets** (`models[]`) are a different, request-counted meter that resets
   daily on paid tiers — the latter is the **authoritative** per-account Gemini
   number, so it's preserved in the legacy fields.

In short: **Gemini uses its authoritative REQUESTS buckets; Claude/GPT have no
such bucket, so they can only be approximated by `fetchAvailableModels`' pool
remaining fraction** — a real, decreasing pool level, but **shared per provider
pool, not a precise single-model quota.**

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
   tier/account; `fetchAvailableModels` adds the non-Google pool fractions. (The
   `daily-cloudcode-pa.googleapis.com` alias works too.)

The refreshed token is used in-memory — `agy` maintains its own keyring token
independently (this tool only writes a rotated refresh_token back, best-effort,
so an old token going stale doesn't force a manual re-login).

## Notes & limitations

- **Windows-first.** The keyring reader is implemented for Windows Credential
  Manager. macOS/Linux fall back to the `oauth_creds.json` file if present.
- **Reset cadence depends on tier.** Free-tier accounts are widely reported to
  refresh on a ~5h window; paid tiers (e.g. AI Ultra) report a daily reset.
  The tool reports whatever the API returns — trust `reset_time`, not folklore.
- Requires a valid logged-in `agy` session. If the credential is missing, log in
  once interactively with `agy`.
- Not affiliated with Google or Antigravity.

## Credits / prior art

The headless **cloud path** (keyring → token refresh → Code Assist quota) is
inspired by prior Antigravity usage checkers — notably
[skainguyen1412/antigravity-usage](https://github.com/skainguyen1412/antigravity-usage)
(cloud-mode fallback) and the `gemini-cli-hud` extension's quota module
(`loadCodeAssist`). This project's contribution is a clean, dependency-free,
**Windows keyring** implementation with agent-friendly JSON and a `--gate` mode.

## License

[MIT](./LICENSE)
