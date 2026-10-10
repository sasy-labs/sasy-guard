# sasy-guard for Codex CLI

A Codex CLI PreToolUse hook that checks Codex's tool calls against the SASY
security policy, through the local `sasy-watch` daemon, before each call runs.
(Codex runs no hook for hosted tools such as web search, or for `write_stdin`.)

- **allow**: the call runs.
- **deny**: the call is blocked; Codex's model reads the policy's reason and
  fix.
- **needs approval**: blocked as well, because a Codex hook cannot ask you.
- **no answer** from the daemon: the call is blocked (`SASY_FAIL_OPEN=true` to
  let calls through instead, only while the daemon's access token is in place).

## Install

Needs `sasy-guard` 0.5.1 or newer and Codex CLI 0.161.0 or newer.

```sh
uv tool install sasy-guard        # or: uv tool upgrade sasy-guard
sasy-guard enable --codex
```

`enable --codex` installs the policy engine and daemon into `~/.sasy`, copies
this hook to `~/.sasy/hooks/codex/`, and adds it to `$CODEX_HOME/hooks.json`
(default `~/.codex`) for every tool call and at session end, keeping any other
hooks there. Running it again changes nothing.

Start `codex` and, when it says **Hooks need review**, trust the hook.
`~/.sasy/hooks/codex/status.sh` reports whether the daemon is up.

Tests, from the repository's root: `node --test
plugins/codex-sasy-guard/test/hook.test.mjs`. Full documentation: the "Enforce
Policy on Codex CLI" page of the sasy-guard docs.
