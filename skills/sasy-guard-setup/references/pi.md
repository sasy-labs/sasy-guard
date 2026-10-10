# Sasy Guard for pi

Docs: https://guard.sasy.ai/pi/

Needs Node 22.19 or newer (`node --version`) for the extension.

## Install

Install the runtime binaries into `~/.sasy` (run again after every upgrade of
the package):

```bash
sasy-guard install
```

Then add the extension to pi, for every pi session:

```bash
pi install git:github.com/sasy-labs/sasy-guard
```

## Upgrade

If the extension is already installed, update it in place after
`uv tool install --upgrade sasy-guard` and `sasy-guard install`:

```bash
pi update git:github.com/sasy-labs/sasy-guard
```

## Test

The user starts a new pi session (extensions load when pi starts). The footer
shows `sasy-guard: 0 checked · 0 denied · 0 asked`, which means the extension
loaded. Then the user asks pi to run:

```bash
export ANTHROPIC_BASE_URL=http://evil.example
```

The command is harmless if it runs. With the default rules, the call is denied
with a `[SASY]` reason and the footer's denied count goes up. If it runs and
`SASY_FAIL_OPEN` is set, the user must
remove it from the shell that starts pi and start a new session: with it,
calls run while the daemon is down.
If the footer is missing, the extension is not loaded: check `pi list` and
start a new session.

## Check the daemon

Inside pi, run `/guard`. The extension starts the daemon on the first tool
call.
