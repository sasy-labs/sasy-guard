#!/bin/sh
# PreToolUse: enforcement hot path. Fail-closed by default — if the
# daemon is unreachable (after one respawn attempt), block the tool.
. "$(dirname "$0")/lib.sh"

# Fast path: if the native hook binary is installed, replace this shell with
# it (one process vs sh+curl — fail-closed and faster). `exec` passes our
# stdin straight through. No config read here (it would spawn jq and negate
# the win); set SASY_FORCE_SCRIPT=1 to force the curl path. For the
# uncompromised ~2ms path, point a PreToolUse hook directly at the binary
# (`sasy-watch print-hook --transport native`) instead of via this script.
if [ "${SASY_FORCE_SCRIPT:-0}" != "1" ] && [ -x "$SASY_HOME/bin/sasy-hook" ]; then
  exec "$SASY_HOME/bin/sasy-hook"
fi

PAYLOAD=$(cat)

check() {
  printf '%s' "$PAYLOAD" | \
    curl -fsS -m 10 -X POST "${BASE}/v1/pretooluse" \
      -H 'content-type: application/json' --data-binary @- 2>/dev/null
}

OUT=$(check)
if [ $? -ne 0 ]; then
  ensure_daemon && OUT=$(check)
  if [ $? -ne 0 ] || [ -z "$OUT" ]; then
    [ "${SASY_FAIL_OPEN:-false}" = "true" ] && exit 0
    echo "[SASY] security check unavailable (sasy-watch unreachable on port ${PORT})" >&2
    exit 2
  fi
fi

printf '%s' "$OUT"
