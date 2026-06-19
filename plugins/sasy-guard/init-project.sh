#!/bin/sh
# Configure a project for persistent SASY policy enforcement.
#
# Writes the sasy-guard hooks into <project>/.claude/settings.json (so plain
# `claude` in that project is enforced — no --plugin-dir needed) and installs
# the daemon + policy config to ~/.sasy. Idempotent; safe to re-run.
#
# Usage:
#   plugins/sasy-guard/init-project.sh [--profile P] [--rule-off a,b]
#                                      [--rule-on a,b] [PROJECT_DIR]
#
#   --profile P      policy profile (default: security, the unified policy)
#   --rule-off a,b   disable these rule groups (subtractive; default is all-on)
#   --rule-on  a,b   opt-in mode: ONLY these groups run
#   PROJECT_DIR      project to configure (default: current directory)
#
# Rule groups: data_loss secret_scan exfil toxic_flow reverse_shell
#   config_persistence agent_redirect curl_sh hidden_unicode public_push
#   review_gate supply_chain dep_scan
set -eu

PROFILE=security
RULE_OFF=""
RULE_ON=""
PROJECT_DIR=""
need_val() { [ $# -ge 2 ] || { echo "error: $1 needs a value"; exit 1; }; }
while [ $# -gt 0 ]; do
  case "$1" in
    --profile)  need_val "$@"; PROFILE="$2"; shift 2 ;;
    --rule-off) need_val "$@"; RULE_OFF="$2"; shift 2 ;;
    --rule-on)  need_val "$@"; RULE_ON="$2";  shift 2 ;;
    -h|--help)  sed -n '2,20p' "$0"; exit 0 ;;
    --)         shift; [ $# -gt 0 ] && PROJECT_DIR="$1"; break ;;
    -*)         echo "error: unknown option $1"; exit 1 ;;
    *)          PROJECT_DIR="$1"; shift ;;
  esac
done
PROJECT_DIR="${PROJECT_DIR:-$PWD}"

# Clean up temp files on any exit (jq writes go through mktemp).
tmp=""
trap 'rm -f "${tmp:-}"' EXIT

PLUGIN_DIR="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
SCRIPTS="$PLUGIN_DIR/scripts"
SASY_HOME="${SASY_HOME:-$HOME/.sasy}"

# Tell `setup` where the plugin assets live — a compiled (bun --compile) daemon
# binary can't locate profiles/ from its own (virtual) path, so without this the
# release bundle silently installs no profiles.
export CLAUDE_PLUGIN_ROOT="$PLUGIN_DIR"

# Release-bundle layout is <bundle>/bin + <bundle>/plugins/sasy-guard. If a
# sibling bin/ ships binaries, point setup at them — so the bundle is a
# ONE-command enable (no separate install.sh step). `setup` copies the daemon +
# hook into ~/.sasy/bin itself; the engine isn't installed by setup, so copy it
# to a stable location and point SASY_BIN there (a bundle path would dangle if
# the bundle is moved/removed).
BUNDLE_BIN="$(CDPATH= cd -- "$PLUGIN_DIR/../../bin" 2>/dev/null && pwd || true)"
if [ -n "$BUNDLE_BIN" ] && [ -x "$BUNDLE_BIN/sasy-watch" ]; then
  mkdir -p "$SASY_HOME/bin"
  cp "$BUNDLE_BIN/sasy" "$SASY_HOME/bin/sasy" && chmod +x "$SASY_HOME/bin/sasy"
  export SASY_BIN="$SASY_HOME/bin/sasy"
  export SASY_WATCH_BIN="$BUNDLE_BIN/sasy-watch"
  export SASY_HOOK_BIN="$BUNDLE_BIN/sasy-hook"
fi

# 1. Resolve the daemon binary and run global setup (installs the daemon to
#    ~/.sasy/bin, copies profiles + auth config, writes ~/.sasy/config.json).
. "$SCRIPTS/lib.sh"
WATCH_BIN="$(find_watch_bin)" || { echo "error: sasy-watch binary not found (build packages/claude-code or set SASY_WATCH_BIN)"; exit 1; }
echo "→ installing daemon + policy config to $SASY_HOME (profile: $PROFILE)"
# shellcheck disable=SC2086
$WATCH_BIN setup --mode local --profile "$PROFILE"

# 2. Apply rule-group flags to the global daemon config, if any.
if [ -n "$RULE_OFF" ] || [ -n "$RULE_ON" ]; then
  command -v jq >/dev/null 2>&1 || { echo "error: jq is required for --rule-off/--rule-on"; exit 1; }
  CFG="$SASY_HOME/config.json"
  # Split on commas, trim surrounding whitespace, drop empties — so `a, b` and a
  # trailing comma don't yield " b"/"" tokens that match no rule group.
  to_json_array() { printf '%s' "$1" | tr ',' '\n' | jq -R 'gsub("^\\s+|\\s+$";"")' | jq -s 'map(select(length > 0))'; }
  tmp="$(mktemp)"
  jq \
    --argjson off "$( [ -n "$RULE_OFF" ] && to_json_array "$RULE_OFF" || echo null )" \
    --argjson on  "$( [ -n "$RULE_ON" ]  && to_json_array "$RULE_ON"  || echo null )" \
    'if $off != null then .ruleOff = $off else . end
     | if $on != null then .ruleOn = $on else . end' \
    "$CFG" > "$tmp" && mv "$tmp" "$CFG"
  echo "→ rule flags: off=[$RULE_OFF] on=[$RULE_ON]"
fi

# 3. Write the four hooks into <project>/.claude/settings.json (absolute script
#    paths; the daemon is found via ~/.sasy/bin by lib.sh, no plugin env needed).
SETTINGS_DIR="$PROJECT_DIR/.claude"
SETTINGS="$SETTINGS_DIR/settings.json"
mkdir -p "$SETTINGS_DIR"

# Build the hooks object with jq so $SCRIPTS is JSON-escaped (a plugin path with
# a quote/space/backslash must not corrupt — or inject into — a settings file
# Claude Code EXECUTES). Requires jq; the four hook commands are absolute paths.
command -v jq >/dev/null 2>&1 || { echo "error: jq is required to write $SETTINGS safely"; exit 1; }
hooks_json() {
  jq -n --arg s "$SCRIPTS" '{
    SessionStart: [{ hooks: [{ type: "command", command: ($s + "/session-start.sh"), timeout: 120 }] }],
    PreToolUse:   [{ hooks: [{ type: "command", command: ($s + "/pretooluse.sh"),    timeout: 30  }] }],
    PostToolUse:  [{ hooks: [{ type: "command", command: ($s + "/posttooluse.sh"),   timeout: 10  }] }],
    SessionEnd:   [{ hooks: [{ type: "command", command: ($s + "/session-end.sh"),   timeout: 10  }] }]
  }'
}

tmp="$(mktemp)"
if [ -f "$SETTINGS" ]; then
  # Merge into any existing settings.json (overwrites only the four hook keys).
  jq --argjson h "$(hooks_json)" '.hooks = ((.hooks // {}) + $h)' "$SETTINGS" > "$tmp" && mv "$tmp" "$SETTINGS"
else
  jq -n --argjson h "$(hooks_json)" '{ hooks: $h }' > "$tmp" && mv "$tmp" "$SETTINGS"
fi

echo "✓ $PROJECT_DIR is configured for SASY enforcement."
echo "  Run 'claude' in it — tool calls are checked; denials show a [SASY] reason."
