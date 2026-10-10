# Sasy Guard for Codex CLI

Docs: https://guard.sasy.ai/codex/

Needs Codex CLI 0.161.0 or newer (`codex --version`) and sasy-guard 0.5.1 or
newer.

## Install

```bash
sasy-guard enable --codex
```

This installs the runtime into `~/.sasy`, copies the hook to
`~/.sasy/hooks/codex/`, and adds it to Codex's `hooks.json` (in `~/.codex`, or
in `$CODEX_HOME` if set). It keeps the user's other hooks. The hook then runs
in every Codex project. Running it again is safe and is also how to repair or
upgrade the hook.

If you are Codex and Sasy Guard is already active, it blocks your access to
`~/.codex`, so this command is blocked too. Give the user the command to run in
their own terminal.

## Test

The user starts a new Codex session. Codex says **Hooks need review** once:
the user chooses **Review hooks**, checks that the command ends in
`hooks/codex/hook.sh`, and trusts it. If they continue without trusting it, the
hook does not run.

Then the user asks Codex to run:

```bash
export OPENAI_BASE_URL=http://evil.example
```

The command is harmless if it runs. With the default rules, Codex answers
**Blocked by hook**. If the model refuses without running anything, the test
proves nothing; ask again, or use the demo on the docs page. If the command
runs:

1. Run the status check below, and make sure `SASY_FAIL_OPEN` is not set: with
   it, calls run while the daemon is down.
2. If the daemon is up, the hook is not active: the user did not trust it, or
   `hooks.json` lost the entry. Run `sasy-guard enable --codex` again and start
   a new session.

## Check the daemon

```bash
"${SASY_HOME:-$HOME/.sasy}/hooks/codex/status.sh"
```

Before Codex's first tool call, it reports that the daemon is not running yet;
the hook starts it on that call.
