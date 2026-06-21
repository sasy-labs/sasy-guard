"""Boot a throwaway ``sasy-watch`` daemon for the demo.

Mirrors the boot sequence in the policy-compiler repo's
``examples/claude-code/demo.py``: install the local engine + daemon config
under a temporary ``SASY_HOME`` on free ports under the ``security`` profile,
then ``sasy-watch run``. Keeping it on its own ports + home means the user's
real ``~/.sasy`` daemon is never touched, and teardown is a clean kill.
"""

from __future__ import annotations

import json
import os
import subprocess
import time
import urllib.request
from pathlib import Path

from demo.cc_guard.util import find_bin, free_port


class DaemonError(RuntimeError):
    """Raised when the throwaway daemon cannot be booted."""


class Daemon:
    """A throwaway ``sasy-watch`` daemon bound to the ``security`` profile.

    Attributes:
        home: Temporary ``SASY_HOME`` holding config, data, and policies.
        profiles_dir: Directory containing ``security.dl`` (the plugin's
            ``profiles/``).
        plugin_root: The ``sasy-guard`` plugin root (``CLAUDE_PLUGIN_ROOT``).
        port: The daemon's HTTP port once booted (``SASY_WATCH_PORT``).
    """

    def __init__(
        self, home: Path, profiles_dir: Path, plugin_root: Path
    ) -> None:
        self.home = home
        self.profiles_dir = profiles_dir
        self.plugin_root = plugin_root
        self.port: int | None = None
        self._proc: subprocess.Popen[bytes] | None = None
        self._sasy = find_bin("sasy")
        self._watch = find_bin("sasy-watch")

    def _env(self) -> dict[str, str]:
        env = {
            **os.environ,
            "SASY_HOME": str(self.home),
            "SASY_BIN": str(self._sasy),
            "SASY_GUARD_PROFILES": str(self.profiles_dir),
            "CLAUDE_PLUGIN_ROOT": str(self.plugin_root),
        }
        # The daemon is a Bun binary that auto-loads `.env` from its cwd, and an
        # ambient SASY_API_KEY / SASY_AUTH_TOKEN flips it to API-key auth
        # (x-api-key) instead of the local entity auth (x-entity) the co-located
        # passthrough engine expects — which silently denies every call as
        # `(anon)`. Drop them so the config's `entity: local` binding wins.
        # (We also spawn with a clean cwd in `boot()` so no stray project
        # `.env` is auto-loaded.)
        for var in ("SASY_API_KEY", "SASY_AUTH_TOKEN"):
            env.pop(var, None)
        return env

    def boot(self, timeout: float = 90.0) -> None:
        """Set up config + engine and start the daemon; wait for healthz.

        Args:
            timeout: Seconds to wait for the daemon to answer ``/healthz``.

        Raises:
            DaemonError: If binaries are missing, setup fails, or the daemon
                does not come up in time.
        """
        if not self._sasy or not self._watch:
            raise DaemonError(
                "SASY binaries not found. Run `sasy-guard install` first "
                "(or `make sasy-guard-install` in the policy-compiler repo)."
            )
        env = self._env()
        # Spawn with cwd inside the throwaway home so the Bun daemon never
        # auto-loads a project `.env` (e.g. sasy-demo's, which carries a cloud
        # SASY_API_KEY) — see the auth note in `_env`.
        setup = subprocess.run(
            [str(self._watch), "setup", "--mode", "local",
             "--profile", "security"],
            env=env, cwd=str(self.home), capture_output=True, text=True,
        )
        if setup.returncode != 0:
            raise DaemonError(f"sasy-watch setup failed:\n{setup.stderr}")

        dport, sport = free_port(), free_port()
        cfg_path = self.home / "config.json"
        cfg = json.loads(cfg_path.read_text())
        cfg.update(
            endpoint=f"localhost:{sport}", daemonPort=dport, enrich=False
        )
        cfg_path.write_text(json.dumps(cfg))
        self.port = dport

        self._proc = subprocess.Popen(
            [str(self._watch), "run"], env=env, cwd=str(self.home),
            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL,
        )
        base = f"http://127.0.0.1:{dport}"
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                urllib.request.urlopen(f"{base}/healthz", timeout=1).read()
                return
            except Exception:
                time.sleep(0.5)
        self.stop()
        raise DaemonError("daemon did not become healthy in time")

    def stop(self) -> None:
        """Terminate the daemon process (best effort)."""
        if self._proc is None:
            return
        self._proc.terminate()
        try:
            self._proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            self._proc.kill()
        self._proc = None
