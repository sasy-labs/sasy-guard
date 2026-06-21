"""Small shared helpers for the Claude-Code guard demo."""

from __future__ import annotations

import os
import shutil
import socket
from pathlib import Path

# The three vendored binaries placed by ``sasy-guard install`` into ``~/.sasy/bin``.
_BINARIES = ("sasy", "sasy-watch", "sasy-hook")


def free_port() -> int:
    """Return an unused localhost TCP port."""
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


def sasy_home_default() -> Path:
    """The directory ``sasy-guard install`` populates (``$SASY_HOME`` or ~/.sasy)."""
    return Path(os.environ.get("SASY_HOME", Path.home() / ".sasy"))


def find_bin(name: str) -> Path | None:
    """Locate a vendored SASY binary.

    Resolution order: ``$SASY_GUARD_BIN_DIR/<name>``, then
    ``<sasy-home>/bin/<name>``, then ``$PATH``.

    Args:
        name: One of ``sasy`` / ``sasy-watch`` / ``sasy-hook``.

    Returns:
        Absolute path to the binary, or ``None`` if not found.
    """
    override = os.environ.get("SASY_GUARD_BIN_DIR")
    candidates = []
    if override:
        candidates.append(Path(override) / name)
    candidates.append(sasy_home_default() / "bin" / name)
    for cand in candidates:
        if cand.is_file():
            return cand.resolve()
    which = shutil.which(name)
    return Path(which).resolve() if which else None


def missing_binaries() -> list[str]:
    """Return the vendored binaries that cannot be located."""
    return [name for name in _BINARIES if find_bin(name) is None]
