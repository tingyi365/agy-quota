# M2 — opt-in routing of a single AIWF worker through agy-proxy

Off by default. A worker only runs on the free Antigravity Opus pool when its
task explicitly asks for it **and** a live quota gate says there's headroom.
Otherwise it spawns exactly as it always has, on the paid Anthropic API.

## The three moving parts

| piece | file | role |
|-------|------|------|
| resident proxy | `proxy/server.js` + `proxy/start-proxy.ps1` | Anthropic→Antigravity bridge, self-healing |
| spawn-time gate | `proxy/agy-gate.js` | reads the Antigravity **Vertex pool** (claude-opus-4-6-thinking, ~5h reset); go / fallback |
| daemon glue | `agent/lib/agy_route.js` (wired in `agent/index.js` `spawnWorkerPty`) | per-task decision + env injection + fail-safe fallback |

## 1. Start the resident proxy

```
powershell -NoProfile -ExecutionPolicy Bypass -File .\proxy\start-proxy.ps1
```

- Fixed port `8787` (override `AGY_PROXY_PORT`), loopback only.
- Self-heals (while-loop restart with capped backoff), logs to `proxy/agy-proxy.log`.
- On boot it self-checks the agy keyring token + project and logs the result.
- Health: `GET http://127.0.0.1:8787/health` → `{ ok, upstream_model, auth_ready, project }`.
- Stop: it spawns node via `cmd /c` (unbuffered log), so node is a grandchild —
  stop with a tree kill: `taskkill /F /T /PID <launcher-powershell-pid>`.

## 2. Turn ONE worker onto the proxy

Set a single flag on the task JSON before it is spawned:

```jsonc
// tasks/<id>.json
{
  "id": "t_2026...",
  "title": "...",
  "instruction": "...",
  "via_agy": true            // <-- opt in. Absent/false = paid API (unchanged).
}
```

That is the entire opt-in surface. When `spawnWorkerPty` runs that task it calls
`resolveAgyRouting`, which:

1. honors the master kill-switch (`AIWF_AGY_DISABLE=1` → always paid);
2. requires `via_agy === true` (else paid);
3. requires the proxy `/health` to be up and `auth_ready`;
4. runs the **Vertex-pool gate** (`agy-gate.js`); GO only if remaining ≥ threshold;
5. on GO injects `ANTHROPIC_BASE_URL=<proxy>` + `ANTHROPIC_API_KEY` into the
   worker's env so the Claude Code child runs on Antigravity Opus.

**Any** failure or doubt in steps 1–4 → `route:false` → the worker spawns on the
paid API exactly as before. There is no path where this blocks a worker or
changes default-fleet behaviour.

## 3. Gate threshold & config (env on the daemon)

| env | default | meaning |
|-----|---------|---------|
| `AIWF_AGY_DISABLE` | unset | `1` = master kill-switch, force every task to paid |
| `AGY_PROXY_URL` | `http://127.0.0.1:8787` | where the proxy listens |
| `AGY_GATE_THRESHOLD` | `20` | min Vertex-pool % to route; below ⇒ fallback to paid |
| `AGY_PROXY_API_KEY` | `agy-proxy-routed` | value injected as ANTHROPIC_API_KEY (proxy ignores it) |

Check the gate by hand any time:

```
node proxy/agy-gate.js --json            # {decision:"go"|"fallback", remaining_percent, ...}
node proxy/agy-gate.js --threshold 50    # exit 0 go · 10 fallback · 1 error
```

## 4. Safety properties

- **Opt-in, never opt-out by accident.** Default off; needs an explicit per-task
  flag; a global kill-switch overrides everything.
- **No fleet switch.** Nothing routes en masse — it's strictly per task.
- **Fail-safe.** Proxy down, stale agy login, pool below threshold, gate error,
  bad config → paid API. Work never stalls because of the proxy.
- **Pure-addition wiring.** `spawnWorkerPty` gained a pre-spawn block and an
  `...agyEnv` spread; with the flag off, `agyEnv` is `{}` and the spawn is
  byte-for-byte the original behaviour.
