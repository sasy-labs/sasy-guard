# Sasy Guard — Claude Code guard demo harness
#
# Prerequisites:
#   1. Copy .env.example to .env and fill in your keys
#   2. make setup
#   3. `sasy-guard install` (binaries in ~/.sasy/bin) + `claude` on PATH

.PHONY: setup \
        claude-code-guard-demo claude-code-guard-demo-step \
        claude-code-guard-scenario claude-code-guard-serve \
        docs docs-build docs-install

# ── Setup ──────────────────────────────────────────

setup:
	uv sync
	@echo "✓ Dependencies installed"
	@echo "Next: copy .env.example to .env and add your keys"

UV_RUN_SDK := uv run

# Silence gRPC's noisy INFO/WARN messages emitted when agent traffic spawns
# subprocesses, so the demo output stays readable.
export GRPC_VERBOSITY ?= ERROR

# ── Claude Code guard demo (real claude × mock model) ──────
# Drives a REAL headless `claude` session against a deterministic mock Anthropic
# endpoint, so the native PreToolUse hook + live sasy-watch daemon + real
# per-session dependency graph are all exercised end to end. Requires `claude`
# on PATH and `sasy-guard install` (binaries in ~/.sasy/bin); boots its own
# throwaway daemon on free ports.

claude-code-guard-demo:
	$(UV_RUN_SDK) python -m demo.cc_guard --all

claude-code-guard-demo-step:
	STEP_MODE=1 $(UV_RUN_SDK) python -m demo.cc_guard --all --step

# Single rule group: `make claude-code-guard-scenario GROUP=toxic_flow`
claude-code-guard-scenario:
	$(UV_RUN_SDK) python -m demo.cc_guard --scenario $(GROUP)

# Interactive: boot the scripted mock so YOU drive a real `claude` session
# against the guard. GROUP picks the scenario; PROJECT points at YOUR enabled
# repo (the one you ran `sasy-guard enable` on):
#   make claude-code-guard-serve GROUP=toxic_flow PROJECT=/path/to/enabled/repo
claude-code-guard-serve:
	$(UV_RUN_SDK) python -m demo.cc_guard.serve_mock \
	  --scenario $(or $(GROUP),toxic_flow) $(if $(PROJECT),--project $(PROJECT))

# ── Documentation ──────────────────────────────────

docs-install:
	@if [ ! -d docs-site/node_modules ]; then \
	    cd docs-site && npm install; \
	fi

docs: docs-install
	cd docs-site && npm run dev

docs-build: docs-install
	cd docs-site && npm run build
