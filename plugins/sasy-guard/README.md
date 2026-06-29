# sasy-guard

Claude Code plugin enforcing SASY Datalog policies on tool calls.

Four hooks, nothing else: `SessionStart` (ensure the `sasy-watch` daemon,
register the session, pin the policy profile), `SessionEnd` (deregister),
`PreToolUse` (check every tool call via the daemon → `RMProxy.CheckToolCall`;
denied calls block with a `[SASY]` reason, even in bypassPermissions mode), and
`PostToolUse` (signal that an `@ask`'d tool ran — a marker-independent approval
for the detaint recorder). Fail-closed: if the daemon is unreachable after one
respawn attempt, tool calls are blocked (`SASY_FAIL_OPEN=true` to override).

Enforcement reference (integration, RPCs, `@ask`, policy design + Datalog):
[`docs/claude-code-enforcement.md`](../../docs/claude-code-enforcement.md) ·
Design: [`docs/claude-code.md`](../../docs/claude-code.md) ·
Daemon: [`packages/claude-code/`](../../packages/claude-code/)

Live demo: `make claude-code-demo` (builds everything, installs the plugin
config, launches an enforced Claude Code session). Persistent per-project setup:
`make claude-code-init PROJECT=/path` (or `init-project.sh`) writes the project's
`.claude/settings.json` so plain `claude` is enforced there. Multi-platform
release bundles: `.github/workflows/claude-code-release.yml` +
`scripts/build-claude-code-release.sh`.

## Try it (repo dev mode)

```sh
# 1. Policy engine (from repo root; binary per CLAUDE.md build)
SASY_ALLOW_NO_AUTH=1 sasy-services/target/release/sasy serve \
  --evaluator souffle --addr 127.0.0.1:50061 \
  --auth-config config/auth_config.yaml --data-dir /tmp/sasy-data

# 2. Daemon config
mkdir -p ~/.sasy && cat > ~/.sasy/config.json <<EOF
{ "endpoint": "localhost:50061", "insecure": true, "entity": "copilot",
  "failMode": "closed",
  "policyPath": "$PWD/plugins/sasy-guard/profiles/security.dl" }
EOF

# 3. Build the daemon and run a guarded session
(cd packages/claude-code && bun install && bun run build:binary)
claude --plugin-dir plugins/sasy-guard

# Inside the session: `rm -rf` and force pushes are denied with a [SASY] reason.
```

## Profiles (`profiles/`)

- `security.dl` — the unified policy: twelve independently-toggleable
  rule groups (data_loss, secret_scan, exfil, toxic_flow, reverse_shell,
  config_persistence, agent_redirect, curl_sh, hidden_unicode, public_push,
  review_gate, supply_chain), all ON by default. The old `rm-rf-block`,
  `taint-untrusted-fetch`, and `supply-chain` profiles are now groups here.
- `allow-all.dl` — observe-only
- `deny-all.dl` — lockdown (the engine bootstrap posture)

Select via `policyPath` in `~/.sasy/config.json` (pinned per session at
SessionStart; the server dedupes identical sources by content hash). Dial
coverage **without editing the policy** via metadata flags — `rule_off <group>`
to drop a group, or `rule_on <group>` for opt-in mode (e.g. `rule_on data_loss`
reproduces the old `rm-rf-block`). See
[`docs/claude-code-enforcement.md`](../../docs/claude-code-enforcement.md) §4.

## Hot-path transport

Three transports trade latency against fail-open vs fail-closed. Measured
per-call cost (registered session, real check):

| transport | per-call | fails | how |
|---|---|---|---|
| **script** | ~52 ms | **closed** | plugin `scripts/pretooluse.sh` → curl. Zero build, works everywhere. |
| **native** | **~2 ms** | **closed** | the `sasy-hook` binary (raw HTTP POST, exit 2 on down). 23× faster than curl, still fail-closed. |
| **http** | ~0.2 ms | **open** | CC POSTs the daemon directly, no subprocess. Fastest, but a down daemon lets tools through. |

**Default behavior:** the plugin's `PreToolUse` script auto-`exec`s the native
`sasy-hook` binary when it's installed (`~/.sasy/bin/sasy-hook`, placed by
`sasy-watch setup`), falling back to curl otherwise — so you get fail-closed
enforcement at ~30 ms with no configuration (the residual cost is the shell
spawn). Set `SASY_FORCE_SCRIPT=1` to force curl.

**For the uncompromised ~2 ms (native) or ~0.2 ms (http) path**, bypass the
shell and point a `PreToolUse` hook *directly* at the binary or daemon in your
`settings.json`. Generate the exact snippet:

```sh
sasy-watch print-hook --transport native   # → direct sasy-hook command hook (fail-closed)
sasy-watch print-hook --transport http     # → http hook to the daemon (FAIL-OPEN)
```

Add the printed `hooks` block to `settings.json` and keep the plugin's
`SessionStart`/`SessionEnd` hooks (they start + register the daemon). Use http
only if you accept "daemon-down ⇒ unchecked." (See `docs/cc-spikes.md` S2.)
