# When the test call is not blocked

Work through these in order and report what you find.

1. **Blocked, but without a `[SASY]` reason.** Another hook or rule blocked it,
   so this proves nothing about Sasy Guard. Check that Sasy Guard is installed
   (below).
2. **`SASY_FAIL_OPEN` is `true`** in the shell that started the agent
   (`echo "${SASY_FAIL_OPEN:-unset}"` in a tool call shows it; any other
   value is off). Calls then run while the daemon is down. The user removes it from that shell's
   environment (an `unset` inside the agent does not reach the agent itself)
   and starts a new session.
3. **The daemon is down.** Run the agent file's **Check** step. If the daemon
   cannot start, `sasy-guard doctor` shows what is missing; run
   `sasy-guard install` (Codex: `sasy-guard enable --codex`) again.
4. **The guard is not loaded.** It loads only when a session starts.
   - Claude Code: `claude plugin list` shows exactly one of `sasy-guard-mod` or
     `sasy-guard` enabled (or the project's `.claude/settings.json` has the
     hooks).
   - Codex: `hooks.json` in `~/.codex` (or `$CODEX_HOME`) has the
     `hooks/codex/hook.sh` entry, and the user trusted it. Run
     `sasy-guard enable --codex` again if the entry is missing.
   - pi: `pi list` shows `git:github.com/sasy-labs/sasy-guard`.

   Then start a new session and test again.
5. **None of these.** The rule may be turned off (`sasy-guard enable` was run
   with `--rule-off` or a non-default profile). Report it with the output of
   `sasy-guard doctor`.

When the user only asked for a check, suggest these fixes without applying them.
