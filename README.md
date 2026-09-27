# Michele-Codex Model Router — Jev router / model fallback proxy for OpenAI Codex

[中文文档](README.zh-CN.md) · [Install instructions for AI agents](INSTALL.md)

A local-first model router for OpenAI Codex on Windows. It decides **which
model handles each turn**, then proxies the request — Codex keeps all of its
tools, permissions, login, sessions, and native `/model` UI.

```text
You -> jev-codex launcher / desktop app
             |
             v
      local proxy (127.0.0.1) ---> Jev decision (hard timeout, fail-open)
             |
             v
          Codex -> OpenAI / DeepSeek / any configured upstream
```

> Internal codename: the npm packages and code identifiers still use
> `jev-router` / `@jev-router/*`; the public project name is
> **Michele-Codex Model Router**.

## What it does

- **Model selection is the on/off switch.** Pick **Jev Auto** in Codex's
  model list and every new turn is routed automatically; pick a concrete
  model and routing pauses for that turn.
- **One model per turn.** Tool loops never switch models mid-task; output,
  once started, is never silently swapped.
- **Technical failover.** 401/402/403/404/429/529, `model_not_found`,
  quota, timeout, network and config errors trigger an immediate retry on the
  next candidate (up to 3 attempts), with the full original request.
- **Model health with a memory.** Failures cool models down (30s → 10min
  exponential); account-level rejections cool down 10min and after **3
  strikes** are permanently disabled until a manual success or
  `health-reset`. State persists in `~/.jev-router/model-health.json`.
- **Quality failures do NOT auto-switch** — if the answer is bad, you switch
  with the native `/model`. Only technical faults are automated.
- **Bounded, private decisions.** Jev receives at most an 8,000-char task
  summary + a 4,000-char context summary — never your code, tool output,
  auth headers, or keys. Decision hard-timeout (default 800ms) fails open.

## What you gain — honestly, it depends on your pool

- **Wide pool (3+ tiers): cost potential.** Most turns are lopsided —
  explanations, small fixes, docs. The router sends those to cheap/fast
  models and reserves expensive ones for turns that need them. That is where
  savings can come from.
- **Narrow pool (2 tiers, e.g. flash/pro): quality, not savings.** If you are
  already on the cheap model there is nothing to save; the router's job is
  upgrading hard turns to the strong model. We do not promise cost savings
  here and will not pretend otherwise.
- **What the decision costs.** With `auto` policy the decision layer is only
  contacted when the candidate pool has **3+ distinct tiers**; small pools are
  decided locally by rules (zero cost, zero latency, zero third party). When
  Jev (`jev-latest` via TypeSafe System One — a *classification* model, no
  completion tokens) is used, it receives a bounded summary (≤8k chars task
  + ≤4k chars context scale) and answers within a hard deadline (default
  800ms, then fail-open to rules).
- **You can measure instead of believing.** Every turn records
  model / tier / confidence / switch reason / `decisionSource`
  (`rules` or `jev`) to `~/.jev-router/decisions.jsonl` —
  `jev explain` prints the latest one, and `evals/` holds a 30-task
  benchmark for before/after comparison.

## Requirements

- Windows 10/11 (only platform tested; Startup-folder and PowerShell logic
  is Windows-specific)
- Node.js 20.12+
- Codex CLI / desktop app, logged in
- Optional: a Jev/TypeSafe API key (without it the router still works with
  rule-based fallback routing)
- Optional: opencodex or any OpenAI-compatible upstream for model access

## Quick start

```powershell
cd <PROJECT_PATH>
npm install
npm run setup:key        # prints where .env is; fill TYPESAFE_API_KEY
npm run health           # expect "ok": true — never prints secrets
```

**Desktop integration (recommended for daily use):**

```powershell
node apps\jev-cli\dist\index.js desktop enable    # expect "issues": []
node apps\jev-cli\dist\index.js desktop status    # expect "ok": true
```

Then open Codex and select **Jev Auto** in the model list. To undo:
`desktop disable`.

**Agent-assisted install:** paste [INSTALL.md](INSTALL.md) to your AI coding
assistant — every step has a machine-checkable expectation and there is an
error-message → fix table.

## Files this install modifies

| Path | Change | Restore |
| --- | --- | --- |
| `C:\Users\<you>\.codex\config.toml` | Adds `model_provider`, a marked `[model_providers.jev_router]` block, and `model_catalog_json` (each tagged `# Jev-Router managed`) | Automatic: backed up to `~\.jev-router\config.toml.backup` first; `desktop disable` restores **only our keys, byte-for-byte** |
| Startup folder \ `jev-router-proxy.vbs` | New hidden autostart entry | `desktop disable` deletes it |
| `~\.jev-router\` | New data directory: logs, merged model catalog, health records, backup | delete the folder for a full purge |

**Never modified:** `~/.codex/auth.json`, Codex login state, opencodex's own
catalog file, opencodex's `openai_base_url`, your default model.

Recommended before first enable — a personal last-resort copy:

```powershell
Copy-Item "$env:USERPROFILE\.codex\config.toml" "$env:USERPROFILE\Desktop\config.toml.manual-backup"
```

Verify the restore round trip (first and third hashes must match):

```powershell
$c = "$env:USERPROFILE\.codex\config.toml"
(Get-FileHash $c).Hash        # state B: routed
node apps\jev-cli\dist\index.js desktop disable | Out-Null
(Get-FileHash $c).Hash        # state A: untouched-by-us
node apps\jev-cli\dist\index.js desktop enable | Out-Null
(Get-FileHash $c).Hash        # must equal the first hash
```

Verified on 2026-09-27: repeated enable/disable cycles produce byte-identical
state pairs. Note that Codex edits `config.toml` itself over time (it added
a `[tui]` entry on the test machine), so whole-file hashes may differ from a
copy taken days ago — that is expected. The router deliberately restores only
its own keys instead of rolling back the whole file, so Codex's own settings
always survive.

## Commands

All commands run as `node apps\jev-cli\dist\index.js <command>` (shown as
`jev <command>` below); `jev-codex` has its own wrapper .cmd.

| Command | Purpose |
| --- | --- |
| `jev-codex [args]` | Launch Codex through the routing proxy |
| `jev route [--model ID] <task>` | Print one routing decision |
| `jev profiles` | List model profiles |
| `jev health` | Config + model health, never prints secrets |
| `jev health-reset [modelId]` | Clear permanently-disabled health records (hot-applies) |
| `jev doctor` | Detect your upstream, list its models, generate model profiles |
| `jev explain` | Latest decision with attempt chain |
| `jev desktop enable / status / disable` | Manage desktop integration |
| `jev mcp` | Optional MCP decision service (not core) |

## Configure it for your own provider

`jev doctor` does the heavy lifting; run it again whenever your models change:

```powershell
node apps\jev-cli\dist\index.js doctor
```

It reads the provider wiring already present in your `config.toml` (a custom
provider block with `experimental_bearer_token`/`requires_openai_auth`, or
the root `openai_base_url`), probes `GET /models`, and writes one model
profile per model into `~/.jev-router/profiles/`. If the probe fails and no
profiles exist, `desktop enable` refuses to install and lists exactly what
is missing — it never takes over and breaks your current setup.

- Tier is guessed from the model name (`pro/high/max` → high,
  `flash/mini/nano` → low, else medium); context comes from the model list
  when provided, otherwise 128k. Profiles say `auto-generated` — edit
  `~/.jev-router/profiles/<model>.json` to calibrate tier/context.
- Auth: the injected `jev_router` provider copies your upstream's auth style
  (bearer token / `requires_openai_auth`), so OpenAI credentials are never
  sent to non-OpenAI endpoints. Models without a profile pass through
  untouched to your upstream.
- Default upstream: whatever your config is wired to. `JEV_CODEX_UPSTREAM_URL`
  overrides it; `desktop enable` fills it into `.env` only when empty.
- Content-level errors (e.g. context overflow) are retried on the next
  candidate but never blame the model — only account/channel rejections
  (`model_not_found`, unsupported, quota) feed the cooldown and
  three-strikes system. `jev health-reset` applies to a running service
  immediately.

## Routing rules (priority order)

1. Explicit model (`-m/--model` or native `/model`) — no auto-switching.
2. Hard constraints: context limit, tool support, cost; frontier tier
   requires `JEV_ALLOW_LONG=1`.
3. Task ↔ model fit (Jev decision, hard timeout, fail-open).
4. Cost, cache affinity, live health state.
5. Jev confidence — low confidence never downgrades your current tier.

## Configuration

Full template: `.env.example`. Real environment variables beat `.env`,
`.env` beats defaults.

| Variable | Default | Meaning |
| --- | --- | --- |
| `TYPESAFE_API_KEY` | empty | Jev decision key (optional) |
| `JEV_DECISION_PROVIDER` | `typesafe` | `typesafe` / `static` |
| `JEV_ROUTE_TIMEOUT_MS` | `800` | decision hard timeout; raise to 4000 on slow relays |
| `JEV_FALLBACK_PROVIDER` / `_MODEL` | `deepseek` / empty | failover target |
| `JEV_CODEX_UPSTREAM_URL` | OpenAI responses | OpenAI-compatible upstream |
| `DEEPSEEK_BASE_URL` / `_KEY` | empty | separate DeepSeek-compatible endpoint/key |
| `JEV_PROXY_PORT` | `10300` | fixed desktop proxy port |
| `JEV_UPSTREAM_TIMEOUT_MS` | `60000` | upstream header deadline (below Codex's ~113s patience) |
| `JEV_DECISION_POLICY` | `auto` | `auto` (rules for pools of ≤2 tiers, Jev at 3+), `always`, `rules` |
| `JEV_ALLOW_LONG` | `0` | let frontier-tier models be candidates |

## Privacy & security

- Decision provider receives only bounded summaries (8k/4k chars), never
  source code, tool output, auth headers, or keys.
- Proxy binds `127.0.0.1` only; logs store task hashes, model, tier,
  confidence, latency, tokens, attempt chain — all key-redaction tested.
- Auto-routing only selects a model; it never loosens Codex permissions or
  approvals.

## Known limitations

- **Windows-only** (tested on Windows 10/11 with Codex CLI 0.158.0-alpha.2).
- Unofficial project, not affiliated with TypeSafe (Jev), OpenAI, or
  opencodex; "Jev" is TypeSafe's product name, used here to describe the
  decision API it exposes.
- opencodex is a third-party, version-sensitive dependency; model
  availability via any account/channel varies (one test machine could use
  luna/terra/deepseek but not sol/astra — the health system exists exactly
  because of this).
- Local decision providers (Ollama/LM Studio/Laya) are not implemented yet;
  `JEV_DECISION_PROVIDER=local` falls back to rules.
- Interactive `/model` menu click-through is the one manually-unverified
  step (catalog entry and `-m jev/auto` are verified).

## Demo recording (for the GitHub/social post)

1. `desktop enable` → `desktop status` all green (5s).
2. Open Codex desktop → `/model` → select **Jev Auto**.
3. Ask a small question → run `jev explain` → show model/tier/confidence/
   attempt chain (5s).
4. Switch to a concrete model → next question logs nothing (routing paused).
5. Record with ScreenToGif/OBS, keep it under 10s, mask any keys and personal
   paths.

## Testing

- `npm test`: **76 unit/integration tests** — config precedence, secret
  redaction, error classification, cooldowns/three-strikes, decision
  timeout, SSE no-buffering, failover, session leases, manual bypass,
  loopback ports, injection/restore round trips.
- CI (GitHub Actions): Node 20 & 24 matrix + secret/personal-path scan.
- Real verified: `codex exec --ephemeral` single-turn and tool-loop turns,
  desktop enable → passthrough → `-m jev/auto` decision → disable hash
  restore → re-enable.

## Evaluation

30 representative tasks and the four-strategy comparison method:
[`evals/tasks.json`](evals/tasks.json), [`evals/README.md`](evals/README.md).

## License

[MIT](LICENSE) © 2026 dengxingyue
