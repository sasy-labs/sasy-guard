"""SASY × Claude Code — real-session security demo.

Drives a REAL ``claude`` (Claude Code) session headlessly against a
deterministic mock Anthropic endpoint, so the native ``PreToolUse`` hook,
the live ``sasy-watch`` daemon, and the real per-session dependency graph
are all exercised end to end. Contrast with the bundled
``examples/claude-code/demo.py`` in the policy-compiler repo, which POSTs
canned tool calls straight to the daemon and never touches the hook wiring
or a real transcript.

Run via ``python -m demo.cc_guard`` (see ``make claude-code-guard-demo``).
"""

from __future__ import annotations

__all__ = ["__doc__"]
