---
description: Run SASY enforcement first-run setup (idempotent)
allowed-tools: Bash(*/sasy-watch:*), Bash(bun:*)
---

Run the SASY enforcement setup. It locates the `sasy` server binary, installs
the policy profiles into `~/.sasy/policies/`, writes `~/.sasy/config.json`, and
is safe to re-run.

Resolve the sasy-watch binary and run setup:

```
"${CLAUDE_PLUGIN_ROOT}/scripts/lib.sh" >/dev/null 2>&1; \
  B="${SASY_WATCH_BIN:-$HOME/.sasy/bin/sasy-watch}"; \
  [ -x "$B" ] || B="${CLAUDE_PLUGIN_ROOT}/../../packages/claude-code/dist/sasy-watch"; \
  "$B" setup $ARGUMENTS
```

If the user passed arguments (e.g. `--profile rm-rf-block`, `--mode remote
--endpoint sasy.fly.dev:443 --api-key …`), forward them. After running,
summarize the resulting mode, endpoint, active profile, and whether the sasy
server binary was found; if not found, tell them to build it (`make build-rust`)
or set `SASY_BIN`.
