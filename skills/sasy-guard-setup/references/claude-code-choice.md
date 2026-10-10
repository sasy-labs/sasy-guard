# Choosing the Claude Code plugin

Run `claude --version` first.

- **Below v2.1.289:** only the hook plugin works. Tell the user why and do not
  offer the mod. If this version has no `claude plugin` command, use the
  one-project hook setup.
- **v2.1.289 or later:** give the user these options in a few lines and ask.
  Do not choose for them.

| | sasy-guard-mod | sasy-guard (hooks) |
|---|---|---|
| Shows decisions in the session (status line, `/guard`) | yes | no |
| Gets the session history | from Claude Code directly | by reading the transcript |
| Subagents in their own git worktree | refused | checked |
| Organization allows only its own mods | does not load | works |
| One project only | no | yes (`sasy-guard enable`) |

Recommend the mod unless the user runs worktree subagents, their organization
restricts mods, or they want the guard in one project only.

Details: https://guard.sasy.ai/claude-code-mod/#choosing-between-the-two-plugins
