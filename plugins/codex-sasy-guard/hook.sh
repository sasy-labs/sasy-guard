#!/bin/bash
# sasy-guard PreToolUse hook for the Codex CLI.
#
# Codex runs this before every tool call, with the call as JSON on stdin. The
# hook asks the local sasy-watch daemon for a decision and blocks the call
# (exit code 2, the reason on stderr) when it is denied. Codex lets a call
# through when a hook fails, so every failure here (no daemon, no access
# token, a bad answer) is turned into a denial too, unless SASY_FAIL_OPEN=true.
set -u
# Codex runs the call when a hook exits with anything but 0 or 2, so any
# other exit (an error in this script) is turned into a denial.
trap 'rc=$?; if [ "$rc" -ne 0 ] && [ "$rc" -ne 2 ]; then echo "[SASY] security check unavailable (hook error)" >&2; exit 2; fi' EXIT

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

# Everything the hook does fits in BUDGET seconds, well within the 60-second
# timeout the docs give it in Codex: Codex runs the call when a hook is still
# running at its timeout. `remaining` is what is left of the budget.
BUDGET="${SASY_CODEX_HOOK_BUDGET:-45}" # overridable for tests only
case "$BUDGET" in '' | *[!0-9]*) BUDGET=45 ;; esac
[ "$BUDGET" -le 45 ] || BUDGET=45
remaining() {
  r=$((BUDGET - SECONDS))
  [ "$r" -gt 0 ] && echo "$r" || echo 0
}

ready() {
  curl -fsS -m 1 "${BASE}/healthz" 2>/dev/null | grep -q '"ready":true'
}

# Starts the daemon if it is down, as the Claude Code hooks do, then waits up
# to 15 seconds for its policy engine, always leaving time for one check.
ensure_daemon() {
  ready && return 0
  [ "$(remaining)" -gt 25 ] || return 1
  if ! curl -fsS -m 1 "${BASE}/healthz" >/dev/null 2>&1; then
    bin="${SASY_WATCH_BIN:-$SASY_HOME/bin/sasy-watch}"
    [ -x "$bin" ] || return 1
    # Bounded here, not only by its own --wait-ms: a start that hangs is
    # stopped after 8 seconds, so the hook still answers in time.
    "$bin" ensure --wait-ms 6000 >/dev/null 2>&1 &
    starter=$!
    for _ in 1 2 3 4 5 6 7 8; do
      kill -0 "$starter" 2>/dev/null || break
      sleep 1
    done
    kill "$starter" 2>/dev/null
  fi
  # Bounded by the clock, not by a count of tries.
  deadline=$((SECONDS + 15))
  while [ "$SECONDS" -lt "$deadline" ] && [ "$(remaining)" -gt 6 ]; do
    ready && return 0
    sleep 1
  done
  return 0
}

# One check, given at most 15 seconds and never more than the budget leaves.
# Exits 99 when no time is left, so the call is denied rather than let through.
check() {
  t=$(remaining)
  [ "$t" -ge 2 ] || return 99
  [ "$t" -le 15 ] || t=15
  curl -fsS -m "$t" -X POST "${BASE}/v1/pretooluse" \
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

# The end of a Codex session: the daemon stops following it. Best effort, and
# quick (Codex gives a SessionEnd hook 3 seconds); it never blocks anything.
# A SessionEnd payload has no `tool_input`, and a tool call's always has one,
# so text inside a tool call's arguments can never make it look like an end.
if ! printf '%s' "$payload" | grep -q '"tool_input"' &&
  printf '%s' "$payload" | grep -Eq '"hook_event_name"[[:space:]]*:[[:space:]]*"SessionEnd"'; then
  if auth=$(auth_file); then
    printf '%s' "$body" | curl -fsS -m 2 -X POST "${BASE}/v1/session/end" \
      -H 'content-type: application/json' -H "@$auth" --data-binary @- >/dev/null 2>&1
  fi
  exit 0
fi

auth=$(auth_file) || { ensure_daemon; auth=$(auth_file); } || deny "sasy-watch is not running on port ${PORT} (no access token)"
out=$(printf '%s' "$body" | check "$auth")
rc=$?
if [ "$rc" -ne 0 ] && ensure_daemon && auth=$(auth_file); then
  out=$(printf '%s' "$body" | check "$auth")
  rc=$?
fi
if [ "$rc" -ne 0 ]; then
  # Only a daemon that does not answer at all can be let through with
  # SASY_FAIL_OPEN: curl could not connect (7), timed out (28), or got no
  # reply (52, 56). An error answer, a missing curl, or missing authentication
  # never inherits the fail-open, as in the Claude Code hooks.
  case "$rc" in
    7 | 28 | 52 | 56)
      if [ "${SASY_FAIL_OPEN:-false}" = "true" ] && auth_file >/dev/null; then exit 0; fi
      deny "sasy-watch did not answer on port ${PORT}" ;;
    *) deny "sasy-watch answered with an error on port ${PORT}" ;;
  esac
fi

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
