"""CLI entry point for the real-Claude-Code security demo.

    python -m demo.cc_guard            # run every scenario
    python -m demo.cc_guard --scenario toxic_flow
    python -m demo.cc_guard --step     # pause between scenarios
"""

from __future__ import annotations

import argparse
import os
import sys


def main() -> int:
    """Parse args and run the demo."""
    parser = argparse.ArgumentParser(
        prog="demo.cc_guard",
        description="SASY × Claude Code — real session, live policy demo.",
    )
    group = parser.add_mutually_exclusive_group()
    group.add_argument(
        "--all", action="store_true",
        help="Run every scenario (the default).",
    )
    group.add_argument(
        "--scenario", metavar="GROUP",
        help="Run a single rule group (e.g. toxic_flow, data_loss).",
    )
    parser.add_argument(
        "--step", action="store_true",
        help="Pause between scenarios for an interactive walkthrough.",
    )
    args = parser.parse_args()

    if args.step:
        os.environ["STEP_MODE"] = "1"

    # Deferred import so STEP_MODE is set before display reads it.
    from demo.cc_guard.runner import run

    groups = [args.scenario] if args.scenario else None
    return run(groups)


if __name__ == "__main__":
    sys.exit(main())
