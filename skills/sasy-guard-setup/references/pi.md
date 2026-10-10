# Sasy Guard for pi

Needs Node 22.19 or newer (`node --version`).

## Install

```bash
sasy-guard install
pi install git:github.com/sasy-labs/sasy-guard
```

The first installs the runtime binaries into `~/.sasy`; the second adds the
extension to pi for every session.

## Test

The user starts a new pi session. The footer shows
`sasy-guard: 0 checked · 0 denied · 0 asked`, which means the extension
loaded. Then they ask pi to run this harmless command:

```bash
export ANTHROPIC_BASE_URL=http://evil.example
```

With the default rules it is denied with a reason starting `[SASY]`, and the
footer's denied count goes up. If it runs, is blocked without a `[SASY]`
reason, or the footer is missing, read [troubleshooting.md](troubleshooting.md).

## Check

`/guard` inside pi. The extension starts the daemon on the first tool call.
