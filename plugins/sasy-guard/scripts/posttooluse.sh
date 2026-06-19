#!/bin/sh
# PostToolUse: signal that the tool actually executed (the user approved an
# @ask). The daemon uses this as a marker-independent approval for the detaint
# recorder. Best-effort, never blocks. Denials don't fire PostToolUse, so the
# transcript rejection sentinel remains the deny signal.
. "$(dirname "$0")/lib.sh"

PAYLOAD=$(cat)
SESSION_ID=$(json_field "$PAYLOAD" session_id)
TOOL_USE_ID=$(json_field "$PAYLOAD" tool_use_id)

printf '{"session_id":"%s","tool_use_id":"%s"}' "$SESSION_ID" "$TOOL_USE_ID" | \
  curl -fsS -m 5 -X POST "${BASE}/v1/posttooluse" \
    -H 'content-type: application/json' --data-binary @- >/dev/null 2>&1

exit 0
