#!/bin/sh
# SessionStart: ensure the sasy-watch daemon is up and register this
# session (pins the configured policy profile server-side).
. "$(dirname "$0")/lib.sh"

PAYLOAD=$(cat)

if ! ensure_daemon; then
  if [ "${SASY_FAIL_OPEN:-false}" = "true" ]; then exit 0; fi
  echo "[SASY] enforcement daemon failed to start — tool calls will be blocked (set SASY_FAIL_OPEN=true to override)" >&2
  exit 0  # SessionStart must not kill the session; PreToolUse enforces fail-closed.
fi

# Forward the verbatim hook payload (session_id, transcript_path, cwd) so the
# daemon can locate and tail the transcript for graph ingestion.
RESP=$(printf '%s' "$PAYLOAD" | \
  curl -fsS -m 60 -X POST "${BASE}/v1/session/start" \
    -H 'content-type: application/json' --data-binary @- 2>/dev/null)

cat <<EOF
{"hookSpecificOutput":{"hookEventName":"SessionStart","additionalContext":"SASY policy enforcement is active for this session. Tool calls are checked against a security policy; denied calls return a [SASY] reason — relay it to the user and follow its suggested fix rather than retrying or working around it."}}
EOF
