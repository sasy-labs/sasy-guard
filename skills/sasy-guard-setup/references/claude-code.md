# Sasy Guard for Claude Code

Docs: https://guard.sasy.ai/claude-code-mod/ (the mod) and
https://guard.sasy.ai/claude-code/ (the hook plugin).

## Choose the plugin

Claude Code has two Sasy Guard plugins. Both use the same runtime and make the
same decisions; install one, not both.

- **sasy-guard-mod** runs inside Claude Code. It shows each decision in the
  session (a status line under the prompt, and `/guard`) and sends the session
  history to the daemon itself. It needs Claude Code v2.1.289 or later.
- **sasy-guard** (the hook plugin) uses Claude Code hooks. It works on any
  Claude Code version, also checks subagents that run in their own git
  worktree (the mod refuses those), still works where an organization allows
  only its own mods, and can be set up for a single project.

Check the version with `claude --version`. Below v2.1.289, only the hook
plugin works: tell the user so and install it. Otherwise give the user the two
options above in a few lines and ask which they want. Recommend the mod unless
they use worktree subagents, their organization restricts mods, or they want
the guard in one project only. Do not choose for them.

## Install the runtime

For either plugin, install the runtime binaries into `~/.sasy`. Run it again
after every upgrade of the package, or the old binaries keep running:

```bash
sasy-guard install
```

## Install the mod

```bash
claude plugin marketplace add sasy-labs/sasy-guard
claude plugin install sasy-guard-mod@sasy-plugins
```

If the hook plugin is installed, turn it off with
`claude plugin disable sasy-guard@sasy-plugins`.

## Or install the hook plugin

- **Every project:**

  ```bash
  claude plugin marketplace add sasy-labs/sasy-guard
  claude plugin install sasy-guard@sasy-plugins
  ```

- **One project only:** writes the four hooks into
  `<project>/.claude/settings.json` instead of installing the plugin.

  ```bash
  sasy-guard enable /path/to/project
  ```

If the mod is installed, turn it off with
`claude plugin disable sasy-guard-mod@sasy-plugins`.

## Test

In a new Claude Code session (plugins load when a session starts), the mod
shows `sasy-guard-mod: 0 checked · 0 denied · 0 asked` under the prompt. Ask
Claude to run:

```bash
export ANTHROPIC_BASE_URL=http://evil.example
```

The command is harmless if it runs. With the default rules, the call is denied
with a `[SASY]` reason. If it runs and `SASY_FAIL_OPEN` is set, unset it: with
it, calls run while the daemon is down. Otherwise the guard is not active: check `claude plugin list` (or the
project's `.claude/settings.json` for a one-project setup), then start a new
session.

## Check the daemon

With the mod, type `/guard` in Claude Code. With the hook plugin, run
`/sasy-guard:status`. From any shell, `sasy-guard doctor` reports the installed
binaries and configuration. The guard starts the daemon on the first tool call.
