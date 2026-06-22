# SASY Demo — Airline Policy Enforcement
#
# Prerequisites:
#   1. Copy .env.example to .env and fill in your keys
#   2. make setup
#
# Quick start (hand-written reference policy):
#   make demo             # Run all 9 scenarios
#   make demo-step        # Interactive walkthrough
#
# Translate an English policy via the SASY cloud service:
#   make translate        # primary: agent-aware Datalog translation
#   make upload-translated
#   make demo-translated

.PHONY: setup \
        translate upload-translated demo-translated demo-translated-step \
        translate-experimental upload-translated-experimental \
        demo-translated-experimental demo-translated-experimental-step \
        demo demo-step upload \
        scenario-1 scenario-2 scenario-3 \
        scenario-4 scenario-5 scenario-6 \
        scenario-7 scenario-8 scenario-9 \
        scenario-1-step scenario-2-step scenario-3-step \
        claude-code-guard-demo claude-code-guard-demo-step \
        claude-code-guard-scenario claude-code-guard-serve \
        docs docs-build docs-install test

# ── Setup ──────────────────────────────────────────

setup:
	uv sync
	@echo "✓ Dependencies installed"
	@echo "Next: copy .env.example to .env and add your keys"

# ── Primary Policy Translation ─────────────────────
# Translates policy_english.md + src/demo/ (your agent) → Datalog
# via the sasy-translate cloud service. Takes ~5–15 min. Writes
# output/airline_policy.dl + output/agent_summary.md, plus
# output/airline_functors.cpp if the policy needs custom C++
# helpers (the demo policy doesn't, so the file is omitted).
UV_RUN_SDK := uv run

# Silence gRPC's noisy INFO/WARN messages (e.g. "FD from fork parent
# still in poll list") emitted when agent traffic spawns subprocesses.
# Demo/scenario recipes export this so the CLI output stays readable.
export GRPC_VERBOSITY ?= ERROR

translate:
	@$(UV_RUN_SDK) python -m demo.translate_cli

upload-translated:
	@$(UV_RUN_SDK) python -c "\
	import os; \
	from sasy.policy import upload_policy_file; \
	path = 'output/airline_policy.dl'; \
	size = os.path.getsize(path); \
	print(f'Uploading {path} ({size:,} bytes) ...'); \
	r = upload_policy_file(path); \
	print(f'  ✓ {r.message}' if r.accepted else f'  ✗ Failed: {r.error_output}')"

demo-translated:
	$(UV_RUN_SDK) python -m demo.main --all --policy-file output/airline_policy.dl

demo-translated-step:
	STEP_MODE=1 $(UV_RUN_SDK) python -m demo.main --all --policy-file output/airline_policy.dl

# ── Policy Upload (hand-written reference) ─────────

upload:
	$(UV_RUN_SDK) python -m demo.main --upload-only

# ── Demo Scenarios ─────────────────────────────────
# Run agent scenarios with live policy enforcement.
# Uploads the hand-written policy.dl first.

demo:
	$(UV_RUN_SDK) python -m demo.main --all

demo-step:
	STEP_MODE=1 $(UV_RUN_SDK) python -m demo.main --all

# ── Claude Code guard demo (real claude × mock model) ──────
# Drives a REAL headless `claude` session against a deterministic mock
# Anthropic endpoint, so the native PreToolUse hook + live sasy-watch daemon +
# real per-session dependency graph are all exercised end to end (unlike the
# policy-compiler repo's synthetic demo, which POSTs canned calls to the
# daemon). Requires `claude` on PATH and `sasy-guard install` (binaries in
# ~/.sasy/bin); boots its own throwaway daemon on free ports.

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

# ── Individual Scenarios ───────────────────────────

scenario-1:
	$(UV_RUN_SDK) python -m demo.main --scenario 1

scenario-2:
	$(UV_RUN_SDK) python -m demo.main --scenario 2

scenario-3:
	$(UV_RUN_SDK) python -m demo.main --scenario 3

scenario-4:
	$(UV_RUN_SDK) python -m demo.main --scenario 4

scenario-5:
	$(UV_RUN_SDK) python -m demo.main --scenario 5

scenario-6:
	$(UV_RUN_SDK) python -m demo.main --scenario 6

scenario-7:
	$(UV_RUN_SDK) python -m demo.main --scenario 7

scenario-8:
	$(UV_RUN_SDK) python -m demo.main --scenario 8

scenario-9:
	$(UV_RUN_SDK) python -m demo.main --scenario 9

# ── Individual Scenarios (interactive) ─────────────

scenario-1-step:
	STEP_MODE=1 $(UV_RUN_SDK) python -m demo.main --scenario 1

scenario-2-step:
	STEP_MODE=1 $(UV_RUN_SDK) python -m demo.main --scenario 2

scenario-3-step:
	STEP_MODE=1 $(UV_RUN_SDK) python -m demo.main --scenario 3

# ── Experimental translator (write_policy) ─────────
# Uses sasy.policy.write_policy — a prototype with extended
# verification (truth table + adversarial checks) but no
# codebase awareness. See docs-site /policy/confidence.

translate-experimental:
	@mkdir -p output
	@echo "Translating policy_english.md → Datalog (experimental) ..."
	@uv run python -c "\
	from sasy.policy import write_policy; \
	policy = open('policy_english.md').read(); \
	r = write_policy(policy=policy, poll_interval=15.0, \
	    on_progress=lambda s,e: print(f'  {s} ({e:.0f}s)')); \
	r.print_summary(); \
	r.save_datalog('output/airline_policy_experimental.dl'); \
	r.save_truth_table('output/truth_table.tsv'); \
	print(f'\nSaved: output/airline_policy_experimental.dl, output/truth_table.tsv')"

upload-translated-experimental:
	@uv run python -c "from sasy.policy import upload_policy_file; \
	r = upload_policy_file('output/airline_policy_experimental.dl'); \
	print('Accepted' if r.accepted else f'Failed: {r.error_output}')"

demo-translated-experimental:
	$(UV_RUN_SDK) python -m demo.main --all --policy-file output/airline_policy_experimental.dl

demo-translated-experimental-step:
	STEP_MODE=1 $(UV_RUN_SDK) python -m demo.main --all --policy-file output/airline_policy_experimental.dl

# ── Validation ─────────────────────────────────────

test:
	$(UV_RUN_SDK) pytest tests/ -xvs

# ── Documentation ──────────────────────────────────

# Installs docs-site npm deps on first use (idempotent).
docs-install:
	@if [ ! -d docs-site/node_modules ]; then \
	    cd docs-site && npm install; \
	fi

docs: docs-install
	cd docs-site && npm run dev

docs-build: docs-install
	cd docs-site && npm run build
