"""Narrated terminal output for the Claude-Code guard demo.

Renders each scenario as a self-contained "card": a plain-English story, the
agent's tool calls with their live verdicts, the guard's ``[SASY]`` reason in
a distinct color, and a pass/fail line explaining why. Scenarios are grouped
into sections so the story builds. ``STEP_MODE=1`` pauses between cards.
"""

from __future__ import annotations

import os
import textwrap
from typing import TYPE_CHECKING

if TYPE_CHECKING:
    from demo.cc_guard.scenarios import Scenario

_C = {
    "deny": "\033[31m", "ask": "\033[33m", "allow": "\033[32m",
    "dim": "\033[2m", "b": "\033[1m", "z": "\033[0m", "cyan": "\033[36m",
    # The guard's own voice — magenta so it never reads as the agent's command.
    "sasy": "\033[1;35m",
}
_LABEL = {
    "deny": f"{_C['deny']}DENY{_C['z']}",
    "ask": f"{_C['ask']}ASK{_C['z']}",
    "allow": f"{_C['allow']}ALLOW{_C['z']}",
}
_WIDTH = 66
STEP_MODE = os.environ.get("STEP_MODE", "") == "1"


def _pause() -> None:
    """Pause for Enter when stepping; fall through on non-TTY / EOF."""
    if not STEP_MODE:
        return
    try:
        input(f"   {_C['dim']}[Enter ▸]{_C['z']}")
    except EOFError:
        pass


def _short(value: str, proj: str) -> str:
    """Shorten a tool input for display (relativize project paths)."""
    value = value.replace(proj + "/", "").replace(proj, ".")
    return value if len(value) <= 52 else value[:51] + "…"


def _wrap(text: str, indent: str) -> str:
    """Wrap ``text`` to the card width with a hanging indent."""
    lines = textwrap.wrap(text, width=_WIDTH - len(indent))
    return "\n".join(indent + ln for ln in lines)


def preamble() -> None:
    """Explain what the viewer is about to watch."""
    bar = "═" * _WIDTH
    print(f"\n{_C['b']}{bar}{_C['z']}")
    print(f"{_C['b']}  SASY × Claude Code — the guard, watched live{_C['z']}")
    print(f"{_C['b']}{bar}{_C['z']}")
    body = (
        "Each scenario below is a REAL, headless `claude` session. A mock "
        "model scripts the tool calls an attacker (or a prompt-injection) "
        "would coax out of the agent — because the real model refuses them "
        "on its own. Every call still flows through Claude Code's native "
        "PreToolUse hook → the live sasy-watch daemon → the policy engine, "
        "on the agent's real per-session dependency graph. The "
    )
    print(_wrap(body, "  "))
    print(f"  {_C['allow']}ALLOW{_C['z']} / {_C['ask']}ASK{_C['z']} / "
          f"{_C['deny']}DENY{_C['z']} verdicts and the "
          f"{_C['sasy']}[SASY]{_C['z']} reasons are the guard's real "
          f"decisions.")
    _pause()


def section_banner(title: str) -> None:
    """Print a section header that groups related scenarios."""
    print(f"\n{_C['b']}── {title} {'─' * (_WIDTH - len(title) - 4)}{_C['z']}")


def card(
    index: int, total: int, scenario: Scenario,
    records: list[dict], gating: dict | None, ok: bool, proj: str,
) -> None:
    """Render one scenario card.

    Args:
        index: 1-based position in the run.
        total: Total scenario count.
        scenario: The scenario being shown.
        records: All hook-tap decision records for the turn (in order).
        gating: The record for the gating (final) call, or ``None``.
        ok: Whether the gating verdict matched the expectation.
        proj: Project path, for relativizing displayed paths.
    """
    head = f"{index}/{total} · {scenario.group}"
    print(f"\n {_C['b']}{head}{_C['z']}   {_C['dim']}{scenario.headline}"
          f"{_C['z']}")
    print(_wrap(scenario.story, " "))
    print()

    for rec in records:
        tool = rec.get("tool_name", "?")
        shown = _short(_shown(rec.get("tool_input") or {}), proj)
        dec = rec.get("decision", "?")
        is_gate = gating is not None and rec is gating
        arrow = "▸" if is_gate else "·"
        print(f"   {arrow} {_C['cyan']}{tool:<8}{_C['z']}{_C['dim']}{shown}"
              f"{_C['z']}  {_LABEL.get(dec, dec)}")
        if is_gate and rec.get("reason"):
            wrapped = _wrap(rec["reason"], "       ")
            print(f"{_C['sasy']}{wrapped}{_C['z']}")

    if gating is None:
        print(f"   {_C['deny']}✗ no tool call reached the hook{_C['z']}")
    else:
        mark = (f"{_C['allow']}✓{_C['z']}" if ok
                else f"{_C['deny']}✗{_C['z']}")
        verb = "as expected" if ok else f"— expected {scenario.expected.upper()}"
        print(f"\n   {mark} {gating.get('decision', '?').upper()} {verb}. "
              f"{_C['dim']}{scenario.note}{_C['z']}")
    _pause()


def _shown(tool_input: dict) -> str:
    """One-line rendering of a tool input."""
    import json

    for key in ("command", "file_path", "url"):
        if key in tool_input:
            return str(tool_input[key])
    return json.dumps(tool_input)


def summary(passed: int, total: int, notes: list[str]) -> None:
    """Print the final tally and any coverage notes."""
    print(f"\n{_C['b']}{'═' * _WIDTH}{_C['z']}")
    print(f"{_C['b']}  {passed}/{total} scenarios matched the expected "
          f"verdict.{_C['z']}")
    for note in notes:
        print(_wrap(note, "  "))
    print()
