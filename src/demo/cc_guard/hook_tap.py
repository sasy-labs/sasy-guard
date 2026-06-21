#!/usr/bin/env python3
"""PreToolUse hook *tap* — runs the real ``sasy-hook`` and records the verdict.

Claude Code invokes this as the project's ``PreToolUse`` hook. It is a thin,
transparent wrapper: it forwards the hook payload to the genuine ``sasy-hook``
binary (which POSTs to the live ``sasy-watch`` daemon → ``CheckToolCall`` over
the real per-session dependency graph), tees a one-line record of the decision
to a log the demo runner reads, then passes ``sasy-hook``'s output and exit
code straight back to Claude Code. The enforcement path is unchanged — this
only observes the decision in transit, so the runner can narrate the true
ALLOW / ASK / DENY verdict (including the ``[SASY]`` reason) without parsing
Claude Code's evolving stream-json.

Self-contained (stdlib only) so it runs under a bare ``python3`` as a
grandchild of ``claude``. Configured entirely via environment variables:

* ``SASY_HOOK_BIN``      — absolute path to the real ``sasy-hook`` binary.
* ``SASY_WATCH_PORT``    — daemon port ``sasy-hook`` should POST to.
* ``SASY_DEMO_TAP_LOG``  — JSONL file to append decision records to.
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import time


def _decision_from(stdout: str, exit_code: int) -> tuple[str, str]:
    """Extract ``(decision, reason)`` from ``sasy-hook``'s output.

    A hook that allows may print the explicit ``allow`` JSON or nothing at
    all (exit 0 ⇒ no objection). A non-zero exit with no parseable decision
    means the daemon was unreachable and the fail-closed path blocked the
    call.
    """
    stdout = stdout.strip()
    if stdout:
        try:
            obj = json.loads(stdout)
            hook = obj.get("hookSpecificOutput", {})
            decision = hook.get("permissionDecision")
            if decision:
                return decision, hook.get("permissionDecisionReason", "")
        except json.JSONDecodeError:
            pass
    if exit_code != 0:
        return "deny", "fail-closed: daemon unreachable"
    return "allow", ""


def main() -> int:
    payload_raw = sys.stdin.read()
    try:
        payload = json.loads(payload_raw or "{}")
    except json.JSONDecodeError:
        payload = {}

    hook_bin = os.environ.get("SASY_HOOK_BIN", "sasy-hook")
    env = {**os.environ}
    proc = subprocess.run(
        [hook_bin], input=payload_raw, capture_output=True, text=True, env=env
    )
    decision, reason = _decision_from(proc.stdout, proc.returncode)

    log_path = os.environ.get("SASY_DEMO_TAP_LOG")
    if log_path:
        record = {
            "ts": time.time(),
            "tool_name": payload.get("tool_name"),
            "tool_input": payload.get("tool_input"),
            "decision": decision,
            "reason": reason,
            "exit_code": proc.returncode,
        }
        with open(log_path, "a", encoding="utf-8") as fh:
            fh.write(json.dumps(record) + "\n")

    # Emit an EXPLICIT permission decision. Claude Code's `dontAsk`/`default`
    # modes deny a tool that needs permission UNLESS the hook explicitly allows
    # it — and sasy-hook is silent on allow, so passing its output straight
    # through would let CC block every allowed context tool (Edit, Bash,
    # WebFetch) before it can build the dependency graph. Normalizing the
    # verdict here makes the SASY decision authoritative (and preserves the
    # deny/ask reason). Always exit 0 — the decision rides in the JSON.
    out = {
        "hookSpecificOutput": {
            "hookEventName": "PreToolUse",
            "permissionDecision": decision,
            "permissionDecisionReason": reason or "[SASY] allowed by policy",
        }
    }
    sys.stdout.write(json.dumps(out))
    if proc.stderr:
        sys.stderr.write(proc.stderr)
    return 0


if __name__ == "__main__":
    sys.exit(main())
