#!/bin/bash
# sasy-guard PreToolUse hook for the Codex CLI.
#
# Codex runs this before every tool call, with the call as JSON on stdin. The
# hook asks the local sasy-watch daemon for a decision and prints a denial when
# there is one. Codex lets a call through when a hook fails, so every failure
# here (no daemon, no access token, a bad answer) is turned into a denial
# (exit code 2, the reason on stderr) unless SASY_FAIL_OPEN=true.
set -u

# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"

deny() {
  echo "[SASY] security check unavailable ($1)" >&2
  exit 2
}

# Starts the daemon if it is down, as the Claude Code hooks do, then waits up
# to 15 seconds for its policy engine. Every wait is bounded so the hook
# answers within its 60-second timeout in Codex: at worst one check (15s), two
# health probes (2s), the start (6s), the wait (16s) and a second check (15s).
ready() {
  curl -fsS -m 1 "${BASE}/healthz" 2>/dev/null | grep -q '"ready":true'
}
ensure_daemon() {
  ready && return 0
  if ! curl -fsS -m 1 "${BASE}/healthz" >/dev/null 2>&1; then
    bin="${SASY_WATCH_BIN:-$SASY_HOME/bin/sasy-watch}"
    [ -x "$bin" ] || return 1
    "$bin" ensure --wait-ms 6000 >/dev/null 2>&1
  fi
  # Bounded by the clock, not by a count of tries.
  deadline=$((SECONDS + 15))
  while [ "$SECONDS" -lt "$deadline" ]; do
    ready && return 0
    sleep 1
  done
  return 0
}

check() {
  curl -fsS -m 15 -X POST "${BASE}/v1/pretooluse" \
    -H 'content-type: application/json' -H "@$1" \
    --data-binary @- 2>/dev/null
}

case "$PORT" in
  '' | *[!0-9]*) deny "SASY_WATCH_PORT \"$PORT\" is not a port" ;;
esac
[ "$PORT" -ge 1 ] && [ "$PORT" -le 65535 ] || deny "SASY_WATCH_PORT \"$PORT\" is not a port"

payload=$(cat)
case "$payload" in
  '{'*) ;;
  *) deny "the hook input is not a JSON object" ;;
esac
# The same call, marked as Codex's, so the daemon reads it with its Codex adapter.
body="{\"agent\":\"codex\",${payload#\{}"

auth=$(auth_file) || { ensure_daemon; auth=$(auth_file); } || deny "sasy-watch is not running on port ${PORT} (no access token)"
out=$(printf '%s' "$body" | check "$auth") || {
  ensure_daemon && auth=$(auth_file) && out=$(printf '%s' "$body" | check "$auth")
} || {
  # Missing authentication never inherits the fail-open, as in the Claude Code hooks.
  if [ "${SASY_FAIL_OPEN:-false}" = "true" ] && auth_file >/dev/null; then exit 0; fi
  deny "sasy-watch did not answer on port ${PORT}"
}

# The daemon answers an allow with `{}`, and a denial with its reason; anything
# else is not a decision, and is blocked.
if [ "$(printf '%s' "$out" | tr -d '[:space:]')" = "{}" ]; then
  exit 0 # An allow is no output: Codex runs the call.
fi
if printf '%s' "$out" | grep -Eq '"permissionDecision"[[:space:]]*:[[:space:]]*"deny"'; then
  printf '%s' "$out"
  exit 0
fi
deny "sasy-watch gave an answer that is not a decision"
exit 0
