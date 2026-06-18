---
description: Show or switch the active SASY policy profile
allowed-tools: Bash(cat:*), Bash(ls:*), Bash(jq:*), Edit
---

Manage the SASY enforcement profile in `~/.sasy/config.json`.

- List available profiles: `ls ~/.sasy/policies/` (security — the unified
  policy; allow-all; deny-all). The old rm-rf-block / taint-untrusted-fetch /
  supply-chain profiles are now rule groups in security; tune them via the
  `ruleOff` / `ruleOn` config arrays instead of switching profiles.
- Show the active one: `jq -r .policyProfile ~/.sasy/config.json`.
- To switch to `$ARGUMENTS`: set `policyProfile` in `~/.sasy/config.json` to
  that name (validate it exists in `~/.sasy/policies/<name>.dl` first).

The change applies to **new** sessions (each pins its profile at SessionStart).
Tell the user to start a fresh Claude Code session — or, if they want it to
affect live sessions immediately, that re-pinning live sessions is not yet
wired (M3 follow-up). If `$ARGUMENTS` is empty, just report the current profile
and the available list.
