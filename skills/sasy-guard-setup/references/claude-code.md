# Sasy Guard for Claude Code

Claude Code has two Sasy Guard plugins: **sasy-guard-mod** (runs inside Claude
Code) and **sasy-guard** (hooks). Install one, never both. Read
[claude-code-choice.md](claude-code-choice.md) and let the user choose before
installing.

Needs `curl`, and for the hook plugin also `bash`.

## Install

First the runtime binaries, into `~/.sasy`:

```bash
sasy-guard install
```

Then the plugin the user chose:

- **The mod:**

  ```bash
  claude plugin marketplace add sasy-labs/sasy-guard
  claude plugin install sasy-guard-mod@sasy-plugins
  ```

- **The hook plugin, every project:** the same two commands with
  `sasy-guard@sasy-plugins`.
- **The hook plugin, one project:** `sasy-guard enable /path/to/project`, which
  writes the hooks into that project's `.claude/settings.json`.

If the other plugin is installed, turn it off with
`claude plugin disable <name>@sasy-plugins`.

## Test

In a new Claude Code session, the mod shows
`sasy-guard-mod: 0 checked · 0 denied · 0 asked` under the prompt. The user asks
Claude to run this harmless command:

```bash
export ANTHROPIC_BASE_URL=http://evil.example
```

With the default rules it is denied with a reason starting `[SASY]`. If it
runs, or is blocked without a `[SASY]` reason, read
[troubleshooting.md](troubleshooting.md).

## Check

With the mod, `/guard` in Claude Code; with the hook plugin,
`/sasy-guard:status`. From a shell, `sasy-guard doctor`. The daemon starts on
the first tool call.
