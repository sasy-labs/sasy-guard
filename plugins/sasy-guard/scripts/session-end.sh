#!/bin/sh
# SessionEnd: deregister the session (best-effort, never blocks exit).
. "$(dirname "$0")/lib.sh"

PAYLOAD=$(cat)
SESSION_ID=$(json_field "$PAYLOAD" session_id)

AUTH_FILE=$(hook_auth_file) || exit 0

printf '{"session_id":"%s"}' "$SESSION_ID" | \
  curl -fsS -m 5 -X POST "${BASE}/v1/session/end" \
    -H 'content-type: application/json' -H "@${AUTH_FILE}" --data-binary @- >/dev/null 2>&1

exit 0
