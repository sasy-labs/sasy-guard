# Sasy Guard for Codex CLI

Needs Codex CLI 0.161.0 or newer (`codex --version`), sasy-guard 0.5.1 or
newer, and `bash` and `curl`.

## Install

```bash
sasy-guard enable --codex
```

This installs the runtime into `~/.sasy` and adds the hook to Codex's
`hooks.json` (in `~/.codex`, or `$CODEX_HOME`), for every Codex project. The
user's other hooks stay as they are.

If you are Codex and Sasy Guard is already active, it blocks your access to
`~/.codex`, and so this command. Give the user the command to run in their own
terminal.

## Test

The user starts a new Codex session. At **Hooks need review** they choose
**Review hooks**, check that the command ends in `hooks/codex/hook.sh`, and
trust it. Then they ask Codex to run this harmless command:

```bash
export OPENAI_BASE_URL=http://evil.example
```

With the default rules Codex answers **Blocked by hook** with a reason starting
`[SASY]`. If the model refuses without running anything, the test proves
nothing; ask again. If the command runs, or is blocked without a `[SASY]`
reason, read [troubleshooting.md](troubleshooting.md).

## Check

```bash
"${SASY_HOME:-$HOME/.sasy}/hooks/codex/status.sh"
```

Before Codex's first tool call it reports the daemon as not running yet; the
hook starts it on that call.
