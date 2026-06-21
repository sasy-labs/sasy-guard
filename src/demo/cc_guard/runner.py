"""Orchestrate the real-Claude-Code security demo.

For each scenario: point the mock model at the scripted turn, run a real
headless ``claude`` session against it (native PreToolUse hook → live
``sasy-watch`` daemon → ``CheckToolCall`` on the real per-session graph),
read the verdict the hook tap recorded, and narrate it.
"""

from __future__ import annotations

import json
import os
import shlex
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

from demo.cc_guard import display
from demo.cc_guard.daemon import Daemon, DaemonError
from demo.cc_guard.fixtures import make_project
from demo.cc_guard.mock_anthropic import MockAnthropic
from demo.cc_guard.scenarios import Scenario, concretize, get_scenarios
from demo.cc_guard.util import find_bin, missing_binaries

_HERE = Path(__file__).resolve().parent
_REPO = _HERE.parents[2]
_PLUGIN = _REPO / "plugins" / "sasy-guard"
_HOOK_TAP = _HERE / "hook_tap.py"
_SESSION_START = _PLUGIN / "scripts" / "session-start.sh"

_PROMPT = "Continue with the next setup step for this project."
_CLAUDE_FLAGS = [
    "--output-format", "stream-json", "--verbose",
    "--permission-mode", "dontAsk", "--model", "claude-sonnet-4-5",
]


def _write_settings(path: Path) -> None:
    """Write the enforcement settings (SessionStart + PreToolUse tap)."""
    hook_cmd = f"{shlex.quote(sys.executable)} {shlex.quote(str(_HOOK_TAP))}"
    settings = {
        "hooks": {
            "SessionStart": [
                {"hooks": [{"type": "command",
                            "command": str(_SESSION_START), "timeout": 120}]}
            ],
            "PreToolUse": [
                {"hooks": [{"type": "command", "command": hook_cmd,
                            "timeout": 30}]}
            ],
        }
    }
    path.write_text(json.dumps(settings))


def _read_tap(log: Path) -> list[dict]:
    """Parse the hook tap's JSONL decision log (oldest first)."""
    if not log.exists():
        return []
    out = []
    for line in log.read_text().splitlines():
        line = line.strip()
        if line:
            try:
                out.append(json.loads(line))
            except json.JSONDecodeError:
                pass
    return out


def _gating_record(records: list[dict], scenario: Scenario) -> dict | None:
    """Return the tap record for the scenario's gating (final) tool call."""
    for rec in reversed(records):
        if rec.get("tool_name") == scenario.gating.tool:
            return rec
    return records[-1] if records else None


def _run_scenario(
    scenario: Scenario, mock: MockAnthropic, project: Path,
    base_env: dict, settings: Path, tap_dir: Path,
) -> tuple[list[dict], dict | None, bool]:
    """Drive one scenario through a real claude session.

    Returns:
        ``(records, gating, ok)`` — all hook-tap records, the gating record
        (or ``None`` if no tool reached the hook), and whether the gating
        verdict matched the expectation.
    """
    concrete = concretize(scenario, str(project), mock.base_url)
    mock.set_script(list(concrete.steps))
    tap = tap_dir / f"tap-{scenario.group}.jsonl"
    tap.unlink(missing_ok=True)

    env = {
        **base_env,
        "SASY_DEMO_TAP_LOG": str(tap),
        # The project's stub bin first so the demo's `gitleaks` resolves.
        "PATH": f"{project / 'bin'}:{os.environ.get('PATH', '')}",
    }
    cmd = ["claude", "-p", _PROMPT, *_CLAUDE_FLAGS, "--settings", str(settings)]
    proc = subprocess.run(
        cmd, env=env, cwd=str(project), capture_output=True, text=True,
        timeout=180,
    )
    (tap_dir / f"claude-{scenario.group}.out").write_text(
        proc.stdout + "\n----- STDERR -----\n" + proc.stderr
    )
    records = _read_tap(tap)
    gating = _gating_record(records, concrete)
    ok = gating is not None and gating.get("decision") == scenario.expected
    return records, gating, ok


def run(groups: list[str] | None = None) -> int:
    """Run the demo for the given rule groups (or all of them).

    Args:
        groups: Rule-group names to run, or ``None`` for the full table.

    Returns:
        Process exit code (0 if every reproducible scenario matched).
    """
    if shutil.which("claude") is None:
        print("error: `claude` (Claude Code) not found on PATH.", file=sys.stderr)
        return 1
    missing = missing_binaries()
    if missing:
        print(f"error: SASY binaries not found ({', '.join(missing)}). "
              f"Run `sasy-guard install` first.", file=sys.stderr)
        return 1

    scenarios = get_scenarios()
    if groups:
        wanted = set(groups)
        scenarios = [s for s in scenarios if s.group in wanted]
        if not scenarios:
            print(f"error: no scenarios match {groups}", file=sys.stderr)
            return 1

    home = Path(tempfile.mkdtemp(prefix="cc-guard-home-"))
    cc_cfg = home / "cc-config"
    cc_cfg.mkdir(parents=True, exist_ok=True)
    _HOOK_TAP.chmod(0o755)

    daemon = Daemon(home=home, profiles_dir=_PLUGIN / "profiles",
                    plugin_root=_PLUGIN)
    mock = MockAnthropic()
    keep = bool(os.environ.get("SASY_DEMO_KEEP"))
    try:
        print("· booting throwaway sasy-watch daemon…")
        daemon.boot()
        mock.start()
        settings = home / "settings.json"
        _write_settings(settings)

        base_env = {
            "ANTHROPIC_BASE_URL": mock.base_url,
            "ANTHROPIC_API_KEY": "sasy-guard-demo-dummy",
            "CLAUDE_CONFIG_DIR": str(cc_cfg),
            "SASY_HOME": str(home),
            "SASY_HOOK_BIN": str(find_bin("sasy-hook")),
            "SASY_WATCH_PORT": str(daemon.port),
        }
        display.preamble()

        total = len(scenarios)
        passed = 0
        current_section = None
        for index, scenario in enumerate(scenarios, start=1):
            if scenario.section != current_section:
                current_section = scenario.section
                display.section_banner(current_section)
            # Fresh project per scenario: edits now execute for real, so a
            # shared dir would let one scenario's edit clobber the next's
            # anchors. Isolation keeps each turn's graph clean.
            project = make_project()
            try:
                records, gating, ok = _run_scenario(
                    scenario, mock, project, base_env, settings, home
                )
                display.card(index, total, scenario, records, gating, ok,
                             str(project))
                passed += ok
            finally:
                if not keep:
                    shutil.rmtree(project, ignore_errors=True)
        notes = [
            "Not shown (need network enrichment): supply_chain, public_push.",
        ]
        display.summary(passed, total, notes)
        return 0 if passed >= total - _non_reproducible(scenarios) else 1
    except DaemonError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    finally:
        mock.stop()
        daemon.stop()
        if keep:
            print(f"· kept temp home: {home}")
        else:
            shutil.rmtree(home, ignore_errors=True)


def _non_reproducible(scenarios: list[Scenario]) -> int:
    """Count scenarios that can't fire faithfully against a real tool run."""
    return sum(1 for s in scenarios if not s.reproducible)
