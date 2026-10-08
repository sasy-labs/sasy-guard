#!/bin/sh
# PostToolUse: (1) signal the tool actually executed (the detaint recorder's
# marker-independent approval), and (2) carry the AskUserQuestion result so the
# daemon can capture the taint-menu selection (tool_response.answers). Forward the
# RAW payload (it holds tool_name + tool_response) and echo any hook output (the
# "decision applied" additionalContext). Best-effort, never blocks. Denials don't
# fire PostToolUse, so the transcript rejection sentinel remains the deny signal.
. "$(dirname "$0")/lib.sh"

PAYLOAD=$(cat)
AUTH_FILE=$(hook_auth_file) || exit 0

OUT=$(printf '%s' "$PAYLOAD" | \
  curl -fsS -m 5 -X POST "${BASE}/v1/posttooluse" \
    -H 'content-type: application/json' -H "@${AUTH_FILE}" --data-binary @- 2>/dev/null)
[ -n "$OUT" ] && printf '%s' "$OUT"
exit 0
