---
name: sasy-guard-setup
description: >-
  Install and set up Sasy Guard, which checks a coding agent's tool calls
  against a SASY security policy before they run, for Claude Code, Codex CLI
  or pi. Use when the user asks to install, set up, enable, upgrade, test or
  check Sasy Guard (sasy-guard), or to protect their coding agent with it.
---

# Set up Sasy Guard

Sasy Guard sends each tool call a coding agent makes to a local daemon,
`sasy-watch`, which checks it against the SASY security policy and allows or
blocks it. The runtime comes from the `sasy-guard` Python package; each agent
gets a small plugin, hook or extension. Docs: https://guard.sasy.ai

## What to read

Set up the agent the user names, or else the agent you are running in. Read
only the files the task needs:

| Task | Read |
|---|---|
| Install for Claude Code | [references/claude-code.md](references/claude-code.md) |
| Install for Codex CLI | [references/codex.md](references/codex.md) |
| Install for pi | [references/pi.md](references/pi.md) |
| Upgrade or re-enable an existing install | [references/upgrade.md](references/upgrade.md) |
| The test call ran, or the guard seems inactive | [references/troubleshooting.md](references/troubleshooting.md) |

If the user only asks to test or check, change nothing: run the agent file's
**Test** and **Check** steps, report the result, and suggest any fix without
applying it. Run the test yourself only if you are that agent; otherwise ask
the user to run it in that agent.

## Before installing

Check, and stop with a clear explanation if one fails:

- macOS 13 or newer, or Linux with glibc 2.35 or newer, on arm64 or x86-64;
  on x86-64 the CPU must support AVX2 (`uname -sm`, `sw_vers -productVersion`
  or `ldd --version`, `avx2` in `/proc/cpuinfo` or
  `sysctl -n machdep.cpu.leaf7_features`).
- `uv --version`. If uv is missing, ask the user to install it from
  https://docs.astral.sh/uv/getting-started/installation/; do not install it
  yourself.

Then install or upgrade the package: `uv tool install --upgrade sasy-guard`.
If `sasy-guard` is then not found, uv's tool folder is not on `PATH`: run it
as `"$(uv tool dir --bin)/sasy-guard"`, and suggest `uv tool update-shell` to
the user.

## Rules

- Before a command that changes the agent's global configuration, say in one
  sentence what it changes. Run only the commands in these files.
- If Sasy Guard blocks one of your commands, do not work around it. Give the
  user the command to run in their own terminal.
- If `SASY_HOME` is already set, keep it: never unset or override it, and do
  not move an existing install. Set it yourself only if the user asks for a
  location other than `~/.sasy`; it must then stay set in every shell that
  starts the agent.
- A new install takes effect only in a new session, so you cannot test it
  from the session that installed it. End by telling the user to start a new
  session and run the agent file's test. Do not claim the guard works until
  that test is blocked with a `[SASY]` reason.
