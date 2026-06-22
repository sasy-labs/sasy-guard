"""Standalone launcher for the scripted mock Anthropic endpoint.

The demo's :class:`~demo.cc_guard.mock_anthropic.MockAnthropic` is normally
driven in-process by the automated runner. This module exposes it as a
long-running server so you can test the guard **interactively** against a real
``claude`` session in your own project:

1. ``uv run python -m demo.cc_guard.serve_mock --scenario toxic_flow``
2. In another terminal, ``export ANTHROPIC_BASE_URL=<printed url>`` and run
   ``claude`` inside the enabled project — type any prompt; the mock replays
   the scenario's scripted tool calls, each gated by the real SASY hook.

The mock is **scripted, not prompt-aware**: it ignores what you type and emits
the scenario's tool calls in order, advancing one step per assistant turn. The
script therefore plays once per fresh ``claude`` session — to run a different
scenario, restart this server with a new ``--scenario`` and start ``claude``
again.
"""

from __future__ import annotations

import argparse
import json
import signal
import sys
from pathlib import Path

from demo.cc_guard.mock_anthropic import MockAnthropic
from demo.cc_guard.scenarios import (
    HIDDEN_UNICODE,
    Step,
    concretize,
    get_scenario,
    get_scenarios,
)

_DEFAULT_PROJECT = "."  # current dir; point --project at your enabled repo


def _setup_fixtures(proj: Path) -> list[str]:
    """Create the helper files the multi-step scenarios depend on.

    Only writes files that are missing — never overwrites an existing ``.env``,
    source file, or settings. Mirrors the throwaway fixtures the automated demo
    builds, so context rules (secret_scan / review_gate / dep_scan /
    hidden_unicode) have the graph nodes they key on.

    Args:
        proj: The project directory to populate.

    Returns:
        The list of relative paths actually created.
    """
    created: list[str] = []

    def _write(rel: str, content: str, *, executable: bool = False) -> None:
        path = proj / rel
        if path.exists():
            return
        path.parent.mkdir(parents=True, exist_ok=True)
        path.write_text(content)
        if executable:
            path.chmod(0o755)
        created.append(rel)

    # data_loss: a tree to (not) delete.
    _write("build/artifact.txt", "stale build output\n")
    # secret_scan / review_gate: a source file with a known edit anchor.
    _write("app.py", "def main():\n    return 'PLACEHOLDER'\n")
    # dep_scan: a manifest with a known version anchor.
    _write("package.json", json.dumps({"name": "demo", "version": "0.0.0"},
                                       indent=2) + "\n")
    # hidden_unicode: visible-benign text carrying an invisible instruction.
    _write("notes.txt", "Build notes: everything here looks completely "
           "normal." + HIDDEN_UNICODE + "\n")
    # review_gate / dep_scan need a clean gitleaks scan in the slice; ship a
    # stub that reports no leaks (put <project>/bin on PATH to use it).
    _write("bin/gitleaks", "#!/bin/sh\necho 'INF no leaks found'\n",
           executable=True)
    return created


def _summarize(step: Step) -> str:
    """Render a scripted step as a compact one-liner for the banner."""
    for key in ("command", "file_path", "url", "content"):
        if key in step.input:
            value = str(step.input[key]).replace("\n", "\\n")
            if len(value) > 72:
                value = value[:72] + "…"
            return f"{step.tool:8} {value}"
    return f"{step.tool:8} {step.input}"


def _print_banner(scenario_group: str, expected: str, headline: str,
                  note: str, steps: tuple[Step, ...], project: Path,
                  base_url: str) -> None:
    """Print the ready-to-use connection details and the scripted plan."""
    bar = "═" * 66
    print(f"\n{bar}")
    print(f"  mock Anthropic ready — scenario: {scenario_group} "
          f"(expect {expected.upper()})")
    print(bar)
    print(f"  {headline}")
    print(f"  why: {note}\n")
    print("  scripted tool calls (the gating call is the last one):")
    for i, step in enumerate(steps, 1):
        marker = "▸" if i == len(steps) else "·"
        print(f"    {marker} {i}. {_summarize(step)}")
    print(f"\n  In another terminal, run claude against this mock:\n")
    print(f"    cd {project}")
    print(f"    export ANTHROPIC_BASE_URL={base_url}")
    print("    export ANTHROPIC_API_KEY=sk-mock-not-used")
    print("    unset SASY_API_KEY SASY_AUTH_TOKEN")
    print("    claude --dangerously-skip-permissions")
    print("\n  Then type any prompt (e.g. 'do the task'). The mock replays the")
    print("  steps above; SASY gates each one. Ctrl-C here when done.")
    print(f"{bar}\n", flush=True)


def main(argv: list[str] | None = None) -> int:
    """Entry point for ``python -m demo.cc_guard.serve_mock``."""
    parser = argparse.ArgumentParser(
        prog="serve_mock",
        description="Serve the scripted mock Anthropic endpoint for manual "
                    "interactive testing of the SASY Claude-Code guard.",
    )
    parser.add_argument(
        "--scenario", default="toxic_flow",
        help="rule group to script (default: toxic_flow; --list to see all)",
    )
    parser.add_argument(
        "--project", default=_DEFAULT_PROJECT,
        help="enabled project dir whose paths the scripted calls target "
             "(default: current dir)",
    )
    parser.add_argument(
        "--setup-fixtures", action="store_true",
        help="create helper files (app.py, package.json, notes.txt, …) the "
             "multi-step scenarios need; never overwrites existing files",
    )
    parser.add_argument(
        "--list", action="store_true", help="list scenarios and exit",
    )
    args = parser.parse_args(argv)

    if args.list:
        for scenario in get_scenarios():
            print(f"  {scenario.group:20} {scenario.expected:5} "
                  f"{scenario.headline}")
        return 0

    project = Path(args.project).resolve()
    if not project.is_dir():
        print(f"error: project dir not found: {project}", file=sys.stderr)
        return 1

    if args.setup_fixtures:
        created = _setup_fixtures(project)
        print(f"fixtures: {'created ' + ', '.join(created) if created else 'all present'}")

    try:
        scenario = get_scenario(args.scenario)
    except ValueError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    mock = MockAnthropic()
    concrete = concretize(scenario, str(project), mock.base_url)
    mock.set_script(list(concrete.steps))
    mock.start()
    _print_banner(scenario.group, scenario.expected, scenario.headline,
                  scenario.note, concrete.steps, project, mock.base_url)

    try:
        signal.pause()
    except KeyboardInterrupt:
        pass
    finally:
        mock.stop()
        print("\nmock stopped.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
