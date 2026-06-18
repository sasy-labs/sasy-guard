---
description: Show SASY enforcement status (daemon, policy engine, sessions)
allowed-tools: Bash(curl:*)
---

Check the SASY enforcement daemon and report its status concisely.

Run: `curl -fsS -m 2 http://127.0.0.1:${SASY_WATCH_PORT:-51711}/healthz`

- If it responds, summarize: daemon ok, policy engine endpoint, fail mode,
  active session count.
- If it does not respond, say enforcement is DOWN, what that means given
  fail-closed semantics (tool calls will be blocked), and suggest
  `sasy-watch ensure` (or checking `~/.sasy/logs/daemon.log`).
