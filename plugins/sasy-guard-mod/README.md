# sasy-guard-mod

SASY policy enforcement for Claude Code as a
[mod](https://code.claude.com/docs/en/plugins/mods/overview): plugin code that
runs inside Claude Code. It is an alternative to the `sasy-guard` plugin, which
does the same job with settings hooks (separate programs Claude Code starts for
each event). **Install one or the other**: with both, every call is checked
twice.

Both talk to the same local `sasy-watch` daemon and policy engine, installed by
`sasy-guard install` (the `sasy-guard` PyPI package).

## What it does

- **Session start**: starts the daemon if it is down, registers the session
  (`/v1/session/start`), and tells the model that denials carry a `[SASY]`
  reason to relay.
- **Each tool call** (`classic.PreToolUse`): sends the daemon the same request
  the hook plugin's `PreToolUse` hook would (`/v1/pretooluse`) and denies the
  call, asks the user, or lets it go on to any other settings hooks. A
  subagent's call carries the subagent's id, type and folder, which the mod
  learns from `agent.spawn`.
- **After each call** (`classic.PostToolUse`): the daemon's post-tool signal
  (`/v1/posttooluse`), as the hook plugin sends it.
- **Session end**: ends the session at the daemon (`/v1/session/end`).
- **In the session**: a status entry with checked / denied / asked totals, a
  band above the prompt explaining the latest `[SASY]` denial or ask (with a
  Dismiss button), and `/guard`, which reports the daemon's `/healthz` and recent
  decisions without a model turn.

It fails closed. A call is denied when the daemon cannot be reached after one
`sasy-watch ensure` (unless `SASY_FAIL_OPEN=true` and the daemon's hook-auth file
is in place), when the daemon's answer is not one of its exact answer shapes or
authentication is refused, and when the mod cannot name the call's caller: a
subagent running in a git worktree of its own (given one, or entering one), a
subagent that started before
the mod loaded, or any call in a session the mod did not see start. An Agent
call asking for a remote (cloud) subagent is refused too: that subagent's calls
run where neither the mod nor the local daemon sees them. A subagent whose own
definition forces remote isolation cannot be told apart at spawn time, and its
calls are not checked (as with the hook plugin).

## Requirements and limits

- Claude Code v2.1.289 or later. The status entry, band and `/guard` output are
  drawn in the terminal and the Desktop Code tab; the VS Code chat panel and
  `claude -p` draw nothing, but the mod still checks every call there.
- Where an organization allows only its own mods (`allowManagedModsOnly`) the
  mod does not load and nothing is checked: use the `sasy-guard` plugin there.
  `disableAllHooks` turns off mods and settings hooks alike, so neither plugin
  checks anything under it.
- The mod talks to the daemon with `curl`, which must be on `PATH`.

## Develop

```sh
claude plugin validate plugins/sasy-guard-mod   # what the mod hooks and calls
claude plugin test plugins/sasy-guard-mod       # tests/guard.test.ts
claude --plugin-dir plugins/sasy-guard-mod      # load it from this checkout
```
