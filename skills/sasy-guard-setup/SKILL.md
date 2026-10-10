---
name: sasy-guard-setup
description: >-
  Install and set up Sasy Guard, which checks a coding agent's tool calls
  against a SASY security policy before they run, for Claude Code, Codex CLI
  or pi. Use when the user asks to install, set up, enable, upgrade, test or
  check Sasy Guard (sasy-guard), or to protect their coding agent with it.
---

# Set up Sasy Guard

Sasy Guard puts a check in front of every tool call a coding agent makes. A
plugin (Claude Code), a hook (Codex CLI) or an extension (pi) sends each call
to a local daemon, `sasy-watch`, which evaluates the SASY security policy and allows or
blocks the call. The runtime (policy engine and daemon) comes from the
`sasy-guard` Python package.

Full documentation: https://guard.sasy.ai

## 1. Pick the agent

Set up the agent the user names. If they name none, set up the agent you are
running in. Then read only that agent's reference file:

| Agent | Reference |
|---|---|
| Claude Code | [references/claude-code.md](references/claude-code.md) |
| Codex CLI | [references/codex.md](references/codex.md) |
| pi | [references/pi.md](references/pi.md) |

For several agents, do step 2 once, then each agent's steps.

## 2. Check the requirements

Run these checks and stop with a clear explanation if one fails:

- **Platform:** macOS 13 or newer, or Linux with glibc 2.35 or newer, on arm64
  or x86-64. On x86-64 the CPU must support AVX2. Check with `uname -sm`, plus
  `sw_vers -productVersion` on macOS or `ldd --version` on Linux. On x86-64,
  look for `avx2` in `/proc/cpuinfo` (Linux) or in
  `sysctl -n machdep.cpu.leaf7_features` (macOS).
- **uv:** `uv --version`. If uv is missing, do not install it yourself. Tell
  the user to install it from https://docs.astral.sh/uv/getting-started/installation/
  and continue once they have.
- **bash and curl** on `PATH` (the hooks use them).

Then install or upgrade the package:

```bash
uv tool install --upgrade sasy-guard
sasy-guard doctor        # the first line is the installed version
```

## 3. Follow the agent's reference

The reference gives the exact commands, what they change, and how to test.

Before you run a command that changes the agent's global configuration, tell
the user in one sentence what it changes. A request to set up Sasy Guard is
permission to run the commands in the reference; do not run anything else that
changes the user's configuration.

## 4. Hand over

A new plugin, hook or extension takes effect only in a session that starts
after it was installed, so you cannot test it from the session you are in. Finish by
telling the user:

1. to start a new session of the agent (and, for Codex, to trust the hook);
2. the test from the reference, and the result to expect;
3. how to check the daemon later.

## Rules

- If Sasy Guard is already active and blocks one of your commands, do not try
  to get around it. Give the user the exact command to run in their own
  terminal instead. The guard protects its own files and the agent's hook
  configuration on purpose.
- Use `SASY_HOME` only if the user asks for a location other than `~/.sasy`.
  It must then stay set in every shell that starts the agent.
- Report what you ran and what you changed. Do not claim the guard is working
  until the user's test in the new session shows a block.
