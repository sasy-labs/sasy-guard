# Sasy Guard

[![sasy-guard installs/week](https://img.shields.io/pypi/dw/sasy-guard?label=sasy-guard%20installs&color=2563eb)](https://pypistats.org/packages/sasy-guard)

Sasy Guard is a suite of agentic security tools based on compiled policies that
reason over an agent's actions and their provenance. Authorization and safety
rules become deterministic policies, enforced outside the agent, that decide
from what the agent actually did and where each action's data came from across
the session, not from the model's own judgment.

> 🛡️ **Works with [Claude Code](https://guard.sasy.ai/claude-code/),
> [pi](https://guard.sasy.ai/pi/) and [Codex CLI](https://guard.sasy.ai/codex/).**
> One policy engine guards all three. Each agent connects to it through a small
> adapter, which keeps adding another agent simple.

**Quickest setup:** run `npx skills add -g sasy-labs/sasy-guard`, then start your
coding agent and ask it to set up Sasy Guard.

**Full documentation → [guard.sasy.ai](https://guard.sasy.ai)**
