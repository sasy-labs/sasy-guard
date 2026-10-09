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

Codex support needs `sasy-guard` runtime newer than 0.4.0, and Codex CLI
0.161.0 or newer.

```sh
uv tool install sasy-guard && sasy-guard install   # the policy engine + daemon
```

Already have an older `sasy-guard`? Run `uv tool upgrade sasy-guard` and then
`sasy-guard install` instead.

Add the hook to `~/.codex/hooks.json`, with this script's absolute path
(quoted, since Codex runs it through a shell), for
both `PreToolUse` (the checks) and `SessionEnd` (the daemon stops following
the session):

```json
{
  "hooks": {
    "PreToolUse": [
      {
        "matcher": "*",
        "hooks": [
          {
            "type": "command",
            "command": "'/path/to/sasy-guard/plugins/codex-sasy-guard/hook.sh'",
            "timeout": 60
          }
        ]
      }
    ],
    "SessionEnd": [
      {
        "hooks": [
          {
            "type": "command",
            "command": "'/path/to/sasy-guard/plugins/codex-sasy-guard/hook.sh'",
            "timeout": 3
          }
        ]
      }
    ]
  }
}
```

Start `codex` and, when it says **Hooks need review**, trust the hook.
`status.sh` reports whether the daemon is up.

Tests, from the repository's root: `node --test
plugins/codex-sasy-guard/test/hook.test.mjs`. Full documentation: the "Enforce
Policy on Codex CLI" page of the sasy-guard docs.
