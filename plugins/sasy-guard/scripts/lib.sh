#!/bin/sh
# Shared helpers for sasy-guard hook scripts.
SASY_HOME="${SASY_HOME:-$HOME/.sasy}"
PORT="${SASY_WATCH_PORT:-51711}"
BASE="http://127.0.0.1:${PORT}"

# Resolve the sasy-watch binary: explicit override → installed →
# repo-dev compiled binary → bun running the source.
find_watch_bin() {
  # Guard every optional env var — this lib is sourced by init-project.sh under
  # `set -u`, where a bare $SASY_WATCH_BIN reference is a fatal unbound-var error.
  if [ -n "${SASY_WATCH_BIN:-}" ] && [ -x "${SASY_WATCH_BIN:-}" ]; then
    echo "$SASY_WATCH_BIN"; return 0
  fi
  if [ -x "$SASY_HOME/bin/sasy-watch" ]; then
    echo "$SASY_HOME/bin/sasy-watch"; return 0
  fi
  dev="${CLAUDE_PLUGIN_ROOT:-}/../../packages/claude-code/dist/sasy-watch"
  if [ -x "$dev" ]; then
    echo "$dev"; return 0
  fi
  if command -v bun >/dev/null 2>&1 && [ -f "${CLAUDE_PLUGIN_ROOT:-}/../../packages/claude-code/src/main.ts" ]; then
    echo "bun ${CLAUDE_PLUGIN_ROOT:-}/../../packages/claude-code/src/main.ts"; return 0
  fi
  return 1
}

ensure_daemon() {
  curl -fsS -m 1 "${BASE}/healthz" >/dev/null 2>&1 && return 0
  BIN=$(find_watch_bin) || return 1
  # Bound the respawn wait so the PreToolUse script (curl 10s + ensure + curl
  # 10s) stays under Claude Code's 30s hook timeout — a killed hook never runs
  # its `exit 2` deny, so an unbounded ensure on an unstartable daemon would
  # fail OPEN. 6s here ⇒ worst case ~26s ⇒ always reaches the deny in time.
  $BIN ensure --wait-ms 6000 >/dev/null 2>&1
}

# Read config.transport (script|native|http) from ~/.sasy/config.json.
config_transport() {
  if command -v jq >/dev/null 2>&1 && [ -f "$SASY_HOME/config.json" ]; then
    jq -r '.transport // "script"' "$SASY_HOME/config.json" 2>/dev/null
  else
    echo script
  fi
}

# Path to the native hook binary, if installed.
hook_bin() {
  [ -x "$SASY_HOME/bin/sasy-hook" ] && echo "$SASY_HOME/bin/sasy-hook"
}

# Extract a top-level string field from JSON on stdin-captured payload.
# jq when available; sed fallback good enough for CC hook payloads.
json_field() { # $1=json $2=field
  if command -v jq >/dev/null 2>&1; then
    printf '%s' "$1" | jq -r ".$2 // empty"
  else
    printf '%s' "$1" | sed -n "s/.*\"$2\"[[:space:]]*:[[:space:]]*\"\([^\"]*\)\".*/\1/p" | head -1
  fi
}
