# sasy-guard for Codex CLI

This is the Codex CLI PreToolUse hook that sasy-guard installs. Before Codex runs
a tool call, the hook asks the local `sasy-watch` daemon to check it against the
SASY security policy, and it blocks any call the policy denies. A few Codex tools
run no hooks; the page linked below lists them.

**Quickest setup:** run `npx skills add -g sasy-labs/sasy-guard`, then start
Codex and ask it to set up Sasy Guard. The skill installs the runtime and the
hook and tells you how to test it; the steps below do the same by hand.

## Install

```sh
uv tool install sasy-guard        # or: uv tool upgrade sasy-guard
sasy-guard enable --codex
```

This adds the hook to `$CODEX_HOME/hooks.json` (normally `~/.codex/hooks.json`),
so it runs in every Codex project. Then start `codex` and trust the hook when
Codex asks. The [Enforce Policy on Codex CLI](https://guard.sasy.ai/codex/) page
covers the requirements, how to test the hook, how to check the daemon, and the
tools that have no hooks.

## Development

The hook's tests, from the repository's root:

```sh
node --test plugins/codex-sasy-guard/test/hook.test.mjs
```
