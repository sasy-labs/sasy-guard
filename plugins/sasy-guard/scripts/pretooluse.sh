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

# Strip control characters (notably CR/LF) and cap the length before splicing an
# env value into a curl -H argument: a crafted CLAUDE_CODE_ENTRYPOINT/TERM_PROGRAM
# inherited from a wrapper could otherwise inject extra header lines, spoofing the
# host probe or corrupting daemon logs. Mirrors `header_safe` in the native hook,
# which the script transport otherwise lacked.
header_safe() {
  printf '%s' "$1" | tr -d '\000-\037\177' | cut -c1-64
}
HDR_ENTRYPOINT=$(header_safe "${CLAUDE_CODE_ENTRYPOINT:-unknown}")
HDR_TERM=$(header_safe "${TERM_PROGRAM:-}")

check() {
  # Forward the host entrypoint (cli | vscode | …) + terminal program so the
  # daemon can log/act on it (parity with the native hook, which sends the same
  # X-Claude-Code-* headers). The daemon can't read this hook's env itself.
  printf '%s' "$PAYLOAD" | \
    curl -fsS -m 10 -X POST "${BASE}/v1/pretooluse" \
      -H 'content-type: application/json' \
      -H "x-claude-code-entrypoint: ${HDR_ENTRYPOINT:-unknown}" \
      -H "x-claude-code-term-program: ${HDR_TERM}" \
      --data-binary @- 2>/dev/null
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
