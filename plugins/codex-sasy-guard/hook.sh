#!/bin/bash
# sasy-guard PreToolUse hook for the Codex CLI.
#
# Codex runs this before every tool call, with the call as JSON on stdin. The
# hook asks the local sasy-watch daemon for a decision and prints a denial when
# there is one. Codex lets a call through when a hook fails, so every failure
# here (no daemon, no access token, a bad answer) is turned into a denial
# (exit code 2, the reason on stderr) unless SASY_FAIL_OPEN=true.
set -u

SASY_HOME="${SASY_HOME:-$HOME/.sasy}"
PORT="${SASY_WATCH_PORT:-51711}"
BASE="http://127.0.0.1:${PORT}"

deny() {
  echo "[SASY] security check unavailable ($1)" >&2
  exit 2
}

# The daemon's access token: a regular file owned by this user and readable by
# no one else, as the daemon writes it. Prints its path when it can be trusted.
auth_file() {
  f="$SASY_HOME/hook-auth-${PORT}.header"
  [ -f "$f" ] && [ ! -L "$f" ] && [ -O "$f" ] && [ -r "$f" ] || return 1
  mode=$(stat -f %Lp "$f" 2>/dev/null || stat -c %a "$f" 2>/dev/null) || return 1
  case "$mode" in '' | *[!0-7]*) return 1 ;; esac
  [ "$(( 8#$mode & 8#077 ))" -eq 0 ] || return 1
  printf '%s' "$f"
}

# Starts the daemon if it is down, as the Claude Code hooks do, then waits up
# to 15 seconds for its policy engine. Every wait is bounded so the hook
# answers well within its 60-second timeout in Codex: worst case one check
# (15s), the start (6s), the wait (15s) and a second check (15s).
ensure_daemon() {
  curl -fsS -m 1 "${BASE}/healthz" >/dev/null 2>&1 && return 0
  bin="${SASY_WATCH_BIN:-$SASY_HOME/bin/sasy-watch}"
  [ -x "$bin" ] || return 1
  "$bin" ensure --wait-ms 6000 >/dev/null 2>&1
  for _ in 1 2 3 4 5 6 7 8 9 10 11 12 13 14 15; do
    curl -fsS -m 1 "${BASE}/healthz" 2>/dev/null | grep -q '"ready":true' && return 0
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

case "$out" in
  *'"permissionDecision":"deny"'*) printf '%s' "$out" ;;
  # An allow is no output: Codex runs the call.
  '{'*) ;;
  *) deny "sasy-watch gave an answer that is not a decision" ;;
esac
exit 0
