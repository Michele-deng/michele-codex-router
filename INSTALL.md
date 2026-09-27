# Install Michele-Codex Model Router (for AI agents)

> 给人的说明见 [README.md](README.md)（English）/ [README.zh-CN.md](README.zh-CN.md)。
> 本文件设计为**整段复制给你的 AI 编程助手**，由它在你机器上执行安装与验证。

You are an AI assistant installing **Michele-Codex Model Router** for a human
user on **Windows**. Follow the steps in order. After every step, check the
stated expectation; if it does not match, stop and follow the troubleshooting
table instead of improvising. Never print, log, or repeat secret values.

## Preconditions

- Windows 10/11, Node.js 20.12+ (`node -v` must print v20.12 or newer).
- Codex CLI installed and logged in (`codex --version` prints a version).
- The project folder (this repository) is available locally.

## Steps

1. Install dependencies:

   ```powershell
   cd <PROJECT_PATH>
   npm install
   ```

   Expect: exits 0. Failure usually means Node is missing or too old.

2. Create the config file (safe to run twice):

   ```powershell
   npm run setup:key
   ```

   Expect: prints `Configuration file ...` with the path `<PROJECT_PATH>\.env`.
   Ask the human to put their Jev/TypeSafe key after `TYPESAFE_API_KEY=` in
   that file. The key is optional: without it the router still works and
   falls back to rule-based routing; it just cannot use Jev decisions.

3. Health check (never prints secrets):

   ```powershell
   npm run health
   ```

   Expect JSON where `"ok": true`, `"codex"` shows a version (not
   `"not found"`), `"proxyPort": 10300`, and
   `"typesafeKeyConfigured"` reflects whether the human filled the key.

3b. Let the router adapt to this machine (detects the user's upstream,
    probes `GET /models`, generates one model profile per model):

   ```powershell
   node apps\jev-cli\dist\index.js doctor
   ```

   Expect: `"ok": true` with `"profilesGenerated"` > 0 and
   `"issues": []`. If `ok` is false, report the issue strings verbatim and
   stop: `desktop enable` would refuse anyway. Profiles land in
   `~\.jev-router\profiles\`; the user can edit them later to calibrate
   tier/context limits.

4. Wire the Codex desktop app (modifies files, see "What this changes" below):

   ```powershell
   node apps\jev-cli\dist\index.js desktop enable
   ```

   Expect: JSON with `"ok": true` and empty `"issues": []`.

5. Verify the integration:

   ```powershell
   node apps\jev-cli\dist\index.js desktop status
   ```

   Expect: `"ok": true`, `"issues": []`. If not, report the issue strings
   verbatim to the human and follow the table below.

6. Optional end-to-end smoke test (uses one real model call, costs fractions
   of a cent):

   ```powershell
   codex exec --ephemeral --skip-git-repo-check -m jev/auto "Reply with exactly: OK"
   ```

   Expect: a normal Codex reply. In the model list of Codex the human should
   now see **Jev Auto**; choosing it enables routing, choosing a concrete model
   disables routing for that turn.

## What this changes on the machine

| Path | Change | Restore |
| --- | --- | --- |
| `C:\Users\<you>\.codex\config.toml` | Adds `model_provider`, a `[model_providers.jev_router]` block, and `model_catalog_json` (marked with `# Jev-Router managed`) | Automatic: backed up first to `~\.jev-router\config.toml.backup`; `desktop disable` restores only those keys, byte-for-byte |
| Startup folder \ jev-router-proxy.vbs | New hidden autostart entry | `desktop disable` deletes it |
| `~\.jev-router\` | New data directory (logs, merged catalog, health records, backup) | Delete the folder manually if desired |

**Never modified:** `~\.codex\auth.json`, Codex login state, opencodex's own
catalog file, opencodex's `openai_base_url`.

Recommendation before first enable: copy `config.toml` somewhere outside the
 repo as a personal last resort:

```powershell
Copy-Item "$env:USERPROFILE\.codex\config.toml" "$env:USERPROFILE\Desktop\config.toml.manual-backup"
```

Verify a restore round trip (optional, hashes must match pairwise):

```powershell
$c = "$env:USERPROFILE\.codex\config.toml"
(Get-FileHash $c).Hash   # state B: routed
node apps\jev-cli\dist\index.js desktop disable | Out-Null
(Get-FileHash $c).Hash   # state A: pristine
node apps\jev-cli\dist\index.js desktop enable | Out-Null
(Get-FileHash $c).Hash   # must equal the first hash (state B again)
```

Note: Codex edits `config.toml` itself over time (for example it added a
`[tui]` entry on this machine), so a whole-file hash may differ from a copy
made days ago. That is expected: the router restores only its own keys and
deliberately never rolls back Codex's own changes.

## Troubleshooting

| Error text (verbatim prefix) | Fix |
| --- | --- |
| `spawn codex.exe ENOENT` | Codex is not on PATH; the launcher auto-detects `%LOCALAPPDATA%\OpenAI\Codex\bin`. If it still fails, set `JEV_CODEX_BIN=` in `.env` to the full path of `codex.exe`. |
| `Port 10300 is used by another service` | Set `JEV_PROXY_PORT=` in `.env` to a free port, then re-run `desktop enable`. |
| `Model catalog source not found` | Start opencodex (or Codex once) so `opencodex-catalog.json` exists, then re-run `desktop enable`. |
| `no model profiles; run: ... doctor` | Run `node apps\jev-cli\dist\index.js doctor`; if it fails, the upstream endpoint/credentials are missing (the report says which). |
| `model list probe failed` (doctor warning) | The endpoint did not answer `GET /models`. Fix the endpoint or copy/adapt the examples in `profiles/examples`, then re-run doctor. |
| `authentication_error` / `401` from the decision API | Wrong key or wrong endpoint: fix `TYPESAFE_API_KEY` / `JEV_TYPESAFE_ENDPOINT` in `.env`, re-run `npm run health`. |
| `Decision timed out after ...ms` in `jev explain` | Normal fail-open: the request still completed on a fallback model. If frequent, raise `JEV_ROUTE_TIMEOUT_MS` (default on slow relays: 4000). |
| `model_router_error` / `502` in Codex | Run `desktop status`; if `ok` is true, check the tail of `~\.jev-router\desktop-service.log` and the `attemptChain` in `~\.jev-router/decisions.jsonl`. |
| `Error loading config.toml` (TOML parse) | Re-run `desktop enable` once; if it persists, restore from `~\.jev-router\config.toml.backup` or the manual backup. |
| `Unknown model jev-router is used` warning | Expected cosmetic warning for the CLI sentinel model; desktop uses `jev/auto` which has catalog metadata. |
| `WARNING: TERM is set to "dumb"` prompt | Interactive terminal quirk: press `y` + Enter. |
| Desktop routing not active after reboot | Run `desktop status`; if the startup entry is missing, re-run `desktop enable`. |

Note on failures: content-level errors (bad params, context overflow) are
retried on another candidate but never count against a model. Only
account/channel rejections feed cooldowns and the three-strikes permanent
disable; `health-reset` clears those and applies to a running service
immediately.

## Uninstall

```powershell
node apps\jev-cli\dist\index.js desktop disable
```

Then delete the project folder. Optionally delete `~\.jev-router\`.
