#!/bin/bash
# sasy-guard PreToolUse hook for the Codex CLI.
#
# Codex runs this before every tool call, with the call as JSON on stdin. The
# hook asks the local sasy-watch daemon for a decision and blocks the call
# (exit code 2, the reason on stderr) when it is denied. Codex lets a call
# through when a hook fails, so every failure here (no daemon, no access
# token, a bad answer) is turned into a denial too, unless SASY_FAIL_OPEN=true.
set -u

# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"

deny() {
  echo "[SASY] security check unavailable ($1)" >&2
  exit 2
}

# The reason in a denial (`permissionDecisionReason`), its JSON string escapes
# decoded. Prints nothing when there is none.
reason_of() {
  printf '%s' "$1" | awk '
    { s = s $0 "\n" }
    END {
      i = index(s, "\"permissionDecisionReason\"")
      if (!i) exit
      s = substr(s, i + 26)
      if (!sub(/^[ \t\r\n]*:[ \t\r\n]*"/, "", s)) exit
      out = ""
      for (j = 1; j <= length(s); j++) {
        c = substr(s, j, 1)
        if (c == "\"") break
        if (c == "\\") {
          j++; e = substr(s, j, 1)
          if (e == "n") out = out "\n"
          else if (e == "t") out = out "\t"
          else if (e == "r") out = out
          else if (e == "u") { out = out "\\u" substr(s, j + 1, 4); j += 4 }
          else out = out e
          continue
        }
        out = out c
      }
      printf "%s", out
    }'
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
# else is not a decision, and is blocked. A denial is given to Codex as exit
# code 2 with the reason on stderr, never as JSON: output Codex cannot read
# would count as a failed hook, and Codex runs the call after a failed hook.
if [ "$(printf '%s' "$out" | tr -d '[:space:]')" = "{}" ]; then
  exit 0 # An allow is no output: Codex runs the call.
fi
if printf '%s' "$out" | grep -Eq '"permissionDecision"[[:space:]]*:[[:space:]]*"deny"'; then
  reason=$(reason_of "$out")
  printf '%s\n' "${reason:-[SASY] blocked by policy}" >&2
  exit 2
fi
deny "sasy-watch gave an answer that is not a decision"
exit 0
