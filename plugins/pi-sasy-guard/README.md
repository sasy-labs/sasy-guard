# pi-sasy-guard

Sasy Guard for the [pi](https://github.com/earendil-works/pi) coding agent: a pi
extension that checks every tool call, and every `!` command you type, against
a SASY security policy before it runs.

- **deny**: the call is blocked; the model reads the policy's reason and fix.
- **ask**: a dialog whose default choice blocks; "Yes, run it once" lets it run.
  With no UI (print or JSON mode) the call is blocked.
- **no answer** from the daemon: the call is blocked (`SASY_FAIL_OPEN=true` to
  let calls through instead).

Decisions show in pi's footer status, in a widget above the editor, and in
`/guard` (daemon health and recent decisions; `/guard clear` hides the widget).

Full documentation: [guard.sasy.ai/pi](https://guard.sasy.ai/pi/).

## Install

pi support needs `sasy-guard` runtime 0.4.0 or newer (an older runtime does not
accept pi's sessions, so every call would be blocked).

```sh
uv tool install sasy-guard && sasy-guard install   # the policy engine + daemon
pi install git:github.com/sasy-labs/sasy-guard      # this extension, every session
pi -e ./plugins/pi-sasy-guard                       # or: one session, from a clone
```

## How it works

`index.ts` handles pi's `tool_call` and `user_bash` events and asks the local
`sasy-watch` daemon (`daemon.ts`; `SASY_HOME`, default `~/.sasy`, and
`SASY_WATCH_PORT`, default 51711) at `/v1/pretooluse`. Before each check it
pushes the session entries the daemon has not seen to `/v1/session/events`, so
the daemon can judge a call by the session's history (a `curl` after a `.env`
read, for one). `core.ts` holds the parts that need neither pi nor the network.

## Develop

```sh
npm test --prefix plugins/pi-sasy-guard   # Node 22.19+, no install needed
make pi-guard-demo                        # scripted model, real pi session
```
