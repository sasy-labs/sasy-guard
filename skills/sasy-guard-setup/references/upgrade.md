# Upgrade or re-enable Sasy Guard

Do not reinstall a plugin or extension that is already installed; update it in
place. Always start with the runtime:

```bash
uv tool install --upgrade sasy-guard
sasy-guard install          # Codex: sasy-guard enable --codex instead
```

Then, per agent:

- **Claude Code** (use `sasy-guard` instead of `sasy-guard-mod` for the hook
  plugin):

  ```bash
  claude plugin marketplace update sasy-plugins
  claude plugin update sasy-guard-mod@sasy-plugins
  ```

  If `claude plugin list` shows it disabled, run
  `claude plugin enable sasy-guard-mod@sasy-plugins`. For a one-project setup,
  run `sasy-guard enable /path/to/project` again.
- **Codex CLI:** `sasy-guard enable --codex` above already refreshed the hook.
- **pi:** `pi update git:github.com/sasy-labs/sasy-guard`

Then the user starts a new session and runs the test in the agent's file:
[claude-code.md](claude-code.md), [codex.md](codex.md) or [pi.md](pi.md).
