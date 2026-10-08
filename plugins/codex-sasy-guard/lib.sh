#!/bin/bash
# Shared by the Codex hook and status.sh: the daemon's address and its access
# token, checked the same way in both.
SASY_HOME="${SASY_HOME:-$HOME/.sasy}"
PORT="${SASY_WATCH_PORT:-51711}"
BASE="http://127.0.0.1:${PORT}"

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
