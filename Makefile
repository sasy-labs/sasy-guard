# Sasy Guard — Claude Code guard demo harness
#
# Prerequisites:
#   1. Copy .env.example to .env and fill in your keys
#   2. make setup
#   3. `sasy-guard install` (binaries in ~/.sasy/bin) + `claude` on PATH

.PHONY: setup \
        claude-code-guard-demo claude-code-guard-demo-step \
        claude-code-guard-scenario claude-code-guard-serve \
        pi-guard-demo codex-guard-demo claude-code-guard-mod-demo \
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

# pi coding agent: serve the scripted mock for a real `pi` session with the
# sasy-guard pi extension loaded from this checkout (needs `pi` on PATH and
# `sasy-guard install`). GROUP picks the scenario (default toxic_flow):
#   make pi-guard-demo GROUP=data_loss
pi-guard-demo:
	$(UV_RUN_SDK) python -m demo.pi_guard.serve --scenario $(or $(GROUP),toxic_flow)

# Codex CLI: serve the scripted mock for a real `codex` session with the
# sasy-guard hook from this checkout, in a Codex home of its own (needs
# `codex` on PATH and `sasy-guard enable --codex`). GROUP picks the scenario:
#   make codex-guard-demo GROUP=data_loss
codex-guard-demo:
	$(UV_RUN_SDK) python -m demo.codex_guard.serve --scenario $(or $(GROUP),toxic_flow)

# Mod demo: the same scripted mock, with `claude` loading the sasy-guard-mod
# plugin from this checkout, so the mod checks each call and its status entry,
# decision band and /guard show. Each run creates a fresh project in the
# system temp folder, outside this repository and with a git repository of its
# own (so scripted git commands never reach this checkout), with the scenario
# fixtures; PROJECT names your own project instead (then no fixture files are
# written):
#   make claude-code-guard-mod-demo GROUP=agent_redirect
claude-code-guard-mod-demo:
	@if [ -n "$(PROJECT)" ]; then \
	  dir="$(PROJECT)"; fixtures=""; \
	else \
	  dir=$$(mktemp -d "$${TMPDIR:-/tmp}/sasy-guard-mod-demo.XXXXXX") && [ -d "$$dir" ] \
	    || { echo "error: could not create a temporary demo project" >&2; exit 1; }; \
	  git -C "$$dir" init -q || exit 1; fixtures="--setup-fixtures"; \
	fi; \
	$(UV_RUN_SDK) python -m demo.cc_guard.serve_mock \
	  --scenario $(or $(GROUP),toxic_flow) $$fixtures \
	  --project "$$dir" --plugin-dir "$(CURDIR)/plugins/sasy-guard-mod"

# ── Documentation ──────────────────────────────────

docs-install:
	@if [ ! -d docs-site/node_modules ]; then \
	    cd docs-site && npm install; \
	fi

docs: docs-install
	cd docs-site && npm run dev

docs-build: docs-install
	cd docs-site && npm run build
