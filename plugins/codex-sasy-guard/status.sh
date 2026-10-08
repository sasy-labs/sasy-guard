#!/bin/bash
# Reports whether the sasy-watch daemon the Codex hook talks to is up: its
# policy engine, fail mode and live sessions. Codex hooks cannot add a slash
# command, so this is the Codex counterpart of pi's /guard.
set -u
# shellcheck source=lib.sh
. "$(dirname "$0")/lib.sh"
out=$(curl -fsS -m 3 "http://127.0.0.1:${PORT}/healthz" 2>/dev/null) || {
  echo "sasy-guard: daemon not answering on port ${PORT}; Codex tool calls are blocked until it starts"
  exit 1
}
field() { printf '%s' "$out" | sed -n "s/.*\"$1\":\"*\([^,\"}]*\)\"*.*/\1/p"; }
ready=$(field ready)
echo "sasy-guard: daemon up on port ${PORT} · policy engine $([ "$ready" = true ] && echo ready || echo "not ready") · endpoint $(field endpoint) · fail mode $(field failMode) · $(field sessions) session(s)"
token="$SASY_HOME/hook-auth-${PORT}.header"
if auth_file >/dev/null; then
  echo "access token: $token"
else
  echo "access token: missing or not private ($token); every Codex tool call is blocked"
fi
[ "$ready" = true ]
