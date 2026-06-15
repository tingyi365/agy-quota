# agy-proxy — Anthropic Messages API → Antigravity (free Opus) bridge

A local translation proxy that exposes an **Anthropic Messages API** endpoint
(`POST /v1/messages`, incl. streaming SSE and tool use) and forwards every
request to **Antigravity's Gemini-style `generateContent`** RPC, so the
inference runs on the user's Ultra-subscription **free Claude Opus 4.6** quota
instead of the paid Anthropic API.

Point any Anthropic client — including the Claude Code CLI — at it with one env
var and it just works:

```
ANTHROPIC_BASE_URL=http://127.0.0.1:8787
ANTHROPIC_API_KEY=anything-nonempty      # ignored by the proxy, but the CLI wants one set
```

Credentials, OAuth token refresh and project resolution are **reused verbatim**
from the agy-quota pipeline (`src/credentials.js`, `src/api.js`). **No token is
ever hard-coded** — the agy Windows keyring is the only source.

## Why this works (M1 feasibility proof)

The one unproven assumption was whether Antigravity, when proxying Claude,
accepts Gemini-format tool declarations and returns tool calls. It does. Proven
end-to-end with a real `claude` CLI run that issued a `Read` tool call (a full
Read→Glob→Read→answer agent loop), routed entirely through this proxy onto the
free Opus quota. The two GO/NO-GO probes (`probe-toolcall.js`,
`probe-roundtrip.js`) reproduce the tool-call round-trip in both directions.

Key translation facts discovered:
- Claude tool use ⇄ Gemini `functionCall` / `functionResponse` round-trips both ways.
- `finishReason: "OTHER"` + a `functionCall` ⇒ Anthropic `stop_reason: "tool_use"`.
- Antigravity validates the tool `input_schema` as **JSON Schema draft 2020-12**
  *after* its own Gemini-proto parse. So tool schemas must satisfy **both**: the
  proxy whitelists the Gemini-supported keyword subset **and** collapses
  `anyOf`/`oneOf` unions to a single concrete schema (Antigravity's union
  conversion otherwise emits a schema Anthropic rejects — proven by bisection on
  Claude Code's `TaskUpdate.status` field).

## Run it (resident)

```
# self-healing resident launcher (fixed port, restart-on-crash, /health probe, log)
powershell -NoProfile -ExecutionPolicy Bypass -File proxy\start-proxy.ps1

# or bare, for a quick foreground run
node proxy/server.js
```

The launcher self-checks the agy keyring token at boot, logs to
`proxy/agy-proxy.log`, and restarts the server with capped backoff if it dies.
Then in another shell, drive any Anthropic client through it.

### Production hardening (M2)

- **Startup auth self-check** — refreshes the keyring token + resolves the
  project at boot; logs loudly if the agy login is stale (does not crash, so
  `/health` stays reportable).
- **No silent failures** — upstream errors are classified and surfaced with a
  distinct log tag + HTTP status: `QUOTA-EXHAUSTED` (429), `SCHEMA-REJECTED`
  (400), `AUTH-FAILED` / `UPSTREAM-ERROR` (502). Every `/v1/messages` logs one
  line (`OK … -> <stop_reason> in/out tokens`).
- **stop_reason** — `STOP→end_turn`, `MAX_TOKENS→max_tokens`,
  `OTHER`+functionCall`→tool_use`; tool presence always wins.
- **Pure unit tests** — `node proxy/test-translate.js` covers the sanitizer
  (union collapse + keyword whitelist), stop_reason map, tool round-trip,
  multi-tool concurrency and error classification (no network).

### Configuration (env vars)

| env var              | default                     | meaning |
|----------------------|-----------------------------|---------|
| `AGY_PROXY_PORT`     | `8787`                      | listen port |
| `AGY_PROXY_HOST`     | `127.0.0.1`                 | listen host (keep loopback) |
| `AGY_PROXY_MODEL`    | `claude-opus-4-6-thinking`  | Antigravity model every request is forced onto |
| `AGY_PROXY_DEBUG`    | unset                       | set to `1` to log each translated request/response to stderr |

The inbound Anthropic `model` field is **ignored** — that is the whole point:
all traffic is forced onto the free Antigravity Opus pool. Use `--list-models`
in `agy-run` to see other callable ids if you want to change `AGY_PROXY_MODEL`.

### Endpoints

- `POST /v1/messages` — Anthropic Messages API (streaming + non-streaming, tools).
- `POST /v1/messages/count_tokens` — rough estimate (Claude Code pre-flight).
- `GET /health` — `{ ok, upstream_model }`.

## Scope / limits (M1)

- Upstream is called **non-streaming** and buffered; when the client asks for
  `stream:true` the finished result is replayed as Anthropic SSE. (Good enough
  for Claude Code; true token-by-token upstream streaming is a later nicety.)
- Images and prior-turn `thinking` blocks are not forwarded (text + tool use only).
- Tool schema validation fidelity is intentionally reduced for acceptance
  (unions collapsed, unsupported keywords dropped); names/descriptions/enums —
  what actually drives tool use — are preserved.

## Opt-in for a single AIWF worker (M2)

See `M2-SWITCH.md` for wiring one specific AIWF worker through the proxy
(off-by-default, per-task opt-in, automatic fallback to Anthropic).
