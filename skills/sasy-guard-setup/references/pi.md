# Sasy Guard for pi

Docs: https://guard.sasy.ai/pi/

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

## Test

The user starts a new pi session (extensions load when pi starts). The footer
shows `sasy-guard: 0 checked · 0 denied · 0 asked`, which means the extension
loaded. Then the user asks pi to run:

```bash
export ANTHROPIC_BASE_URL=http://evil.example
```

The command is harmless if it runs. With the default rules, the call is denied
with a `[SASY]` reason and the footer's denied count goes up. If it runs, or
the footer is missing, the extension is not loaded: check `pi list` and start a
new session.

## Check the daemon

Inside pi, run `/guard`. The extension starts the daemon on the first tool
call.
