// Tests for the Codex PreToolUse hook (hook.sh), against a stand-in daemon.
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { after, before, test } from "node:test";

const HOOK = join(dirname(fileURLToPath(import.meta.url)), "..", "hook.sh");
const TOKEN = "a".repeat(64);
const CALL = { session_id: "s1", transcript_path: "/tmp/x.jsonl", cwd: "/w", hook_event_name: "PreToolUse", tool_name: "Bash", tool_input: { command: "ls" }, tool_use_id: "call_1" };

let server;
let port;
let home;
let answer = {};
let status = 200;
let requests = [];

before(async () => {
  home = mkdtempSync(join(tmpdir(), "codex-hook-"));
  server = createServer((req, res) => {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      requests.push({ url: req.url, token: req.headers["x-sasy-hook-token"], body });
      res.statusCode = status;
      res.end(typeof answer === "string" ? answer : JSON.stringify(answer));
    });
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  port = server.address().port;
  const header = join(home, `hook-auth-${port}.header`);
  writeFileSync(header, `x-sasy-hook-token: ${TOKEN}\n`);
  chmodSync(header, 0o600);
});

after(() => {
  // Setup may have stopped part-way; clean up only what it made.
  server?.close();
  if (home) rmSync(home, { recursive: true, force: true });
});

// Runs the hook as Codex does, asynchronously so the stand-in daemon in this
// process can answer it.
function runHook(env, input = JSON.stringify(CALL)) {
  return new Promise((resolve) => {
    const child = spawn("bash", [HOOK], { env: { PATH: process.env.PATH, HOME: process.env.HOME, SASY_HOME: home, SASY_WATCH_BIN: join(home, "no-such-bin"), ...env } });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", (d) => (stdout += d));
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
}

test("a denial blocks the call with the daemon's reason; the call is marked as Codex's", async () => {
  requests = [];
  status = 200;
  answer = { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "[SASY] blocked\n\nFix:\n  don't" } };
  const out = await runHook({ SASY_WATCH_PORT: String(port) });
  // Exit code 2 with the reason on stderr: Codex blocks the call and gives the
  // model the reason. Nothing on stdout that Codex could fail to read.
  assert.equal(out.code, 2);
  assert.equal(out.stderr, "[SASY] blocked\n\nFix:\n  don't\n");
  assert.equal(out.stdout, "");
  const sent = JSON.parse(requests[0].body);
  assert.equal(sent.agent, "codex");
  assert.equal(sent.tool_use_id, "call_1");
  assert.equal(requests[0].url, "/v1/pretooluse");
  assert.equal(requests[0].token, TOKEN);
});

test("an allow is no output, so Codex runs the call", async () => {
  status = 200;
  answer = {};
  const out = await runHook({ SASY_WATCH_PORT: String(port) });
  assert.equal(out.code, 0);
  assert.equal(out.stdout, "");
});

test("a proxy in the environment is not used: the check goes to the local daemon", async () => {
  requests = [];
  status = 200;
  answer = {};
  // A proxy that is not there: a request sent to it would fail.
  const proxy = "http://127.0.0.1:9";
  const out = await runHook({ SASY_WATCH_PORT: String(port), http_proxy: proxy, HTTP_PROXY: proxy, ALL_PROXY: proxy, all_proxy: proxy });
  assert.equal(out.code, 0);
  assert.equal(requests.length, 1);
  assert.equal(requests[0].token, TOKEN);
});

test("a curl config file cannot send the check elsewhere", async () => {
  requests = [];
  status = 200;
  answer = {};
  // A .curlrc that would redirect the daemon's port to one nothing listens on.
  const curlHome = mkdtempSync(join(tmpdir(), "codex-curlrc-"));
  writeFileSync(join(curlHome, ".curlrc"), `connect-to = "127.0.0.1:${port}:127.0.0.1:9"\n`);
  try {
    const out = await runHook({ SASY_WATCH_PORT: String(port), CURL_HOME: curlHome });
    assert.equal(out.code, 0);
    assert.equal(requests.length, 1);
  } finally {
    rmSync(curlHome, { recursive: true, force: true });
  }
});

test("a SECONDS value inherited from the environment does not use up the budget", async () => {
  status = 200;
  answer = {};
  const out = await runHook({ SASY_WATCH_PORT: String(port), SECONDS: "100" });
  assert.equal(out.code, 0);
});

test("no usable answer blocks the call (Codex would otherwise run it)", async () => {
  // An answer that is not a decision.
  status = 200;
  answer = "not json";
  let out = await runHook({ SASY_WATCH_PORT: String(port) });
  assert.equal(out.code, 2);
  assert.match(out.stderr, /not a decision/);
  // An error from the daemon.
  status = 500;
  answer = {};
  out = await runHook({ SASY_WATCH_PORT: String(port) });
  assert.equal(out.code, 2);
  assert.match(out.stderr, /\[SASY\] security check unavailable/);
  // No daemon and no access token on the port.
  out = await runHook({ SASY_WATCH_PORT: "9" });
  assert.equal(out.code, 2);
  assert.match(out.stderr, /no access token/);
  // A port that is not a port.
  out = await runHook({ SASY_WATCH_PORT: `${port}x` });
  assert.equal(out.code, 2);
  assert.match(out.stderr, /is not a port/);
  // Input that is not a JSON object.
  status = 200;
  out = await runHook({ SASY_WATCH_PORT: String(port) }, "[]");
  assert.equal(out.code, 2);
});

test("a denial is read however it is spaced; any other answer than an allow is blocked", async () => {
  status = 200;
  answer = '{\n  "hookSpecificOutput": { "permissionDecision" : "deny", "permissionDecisionReason": "[SASY] spaced" }\n}';
  let out = await runHook({ SASY_WATCH_PORT: String(port) });
  assert.equal(out.code, 2);
  assert.match(out.stderr, /spaced/);
  // A truncated denial still blocks: the reason falls back to a generic one.
  answer = '{"hookSpecificOutput":{"permissionDecision":"deny","permissionDeci';
  out = await runHook({ SASY_WATCH_PORT: String(port) });
  assert.equal(out.code, 2);
  assert.match(out.stderr, /\[SASY\] blocked by policy/);
  // A JSON object that is neither `{}` nor a denial is not a decision.
  answer = { error: "engine unavailable" };
  out = await runHook({ SASY_WATCH_PORT: String(port) });
  assert.equal(out.code, 2);
  assert.match(out.stderr, /not a decision/);
});

test("status.sh reports a token others can read as not usable", async () => {
  const header = join(home, `hook-auth-${port}.header`);
  const status = () =>
    new Promise((resolve) => {
      const child = spawn("bash", [join(dirname(HOOK), "status.sh")], { env: { PATH: process.env.PATH, HOME: process.env.HOME, SASY_HOME: home, SASY_WATCH_PORT: String(port) } });
      let stdout = "";
      child.stdout.on("data", (d) => (stdout += d));
      child.on("close", () => resolve(stdout));
    });
  chmodSync(header, 0o644);
  try {
    assert.match(await status(), /missing or not private/);
  } finally {
    chmodSync(header, 0o600);
  }
  assert.match(await status(), /access token: \//);
});

test("an access token others can read is not trusted", async () => {
  const header = join(home, `hook-auth-${port}.header`);
  chmodSync(header, 0o644);
  try {
    status = 200;
    answer = {};
    const out = await runHook({ SASY_WATCH_PORT: String(port) });
    assert.equal(out.code, 2);
    assert.match(out.stderr, /no access token/);
  } finally {
    chmodSync(header, 0o600);
  }
});

test("fail-open lets a call through only when an authenticated daemon does not answer", async () => {
  // A daemon that answers with an error is not "no answer": still blocked.
  status = 500;
  answer = {};
  let out = await runHook({ SASY_WATCH_PORT: String(port), SASY_FAIL_OPEN: "true" });
  assert.equal(out.code, 2);
  assert.match(out.stderr, /answered with an error/);
  // No token on the port: still blocked.
  out = await runHook({ SASY_WATCH_PORT: "9", SASY_FAIL_OPEN: "true" });
  assert.equal(out.code, 2);
  // A trusted token, but nothing listens on the port: let through.
  const header = join(home, "hook-auth-9.header");
  writeFileSync(header, `x-sasy-hook-token: ${TOKEN}\n`);
  chmodSync(header, 0o600);
  try {
    out = await runHook({ SASY_WATCH_PORT: "9", SASY_FAIL_OPEN: "true" });
    assert.equal(out.code, 0);
    assert.equal(out.stdout, "");
    // Without SASY_FAIL_OPEN the same call is blocked.
    out = await runHook({ SASY_WATCH_PORT: "9" });
    assert.equal(out.code, 2);
    assert.match(out.stderr, /did not answer/);
  } finally {
    rmSync(header, { force: true });
  }
});

test("a daemon that never answers is denied within the hook's time budget", async () => {
  // Accepts the request and never answers.
  const hung = createServer(() => {});
  await new Promise((r) => hung.listen(0, "127.0.0.1", r));
  const hungPort = hung.address().port;
  const header = join(home, `hook-auth-${hungPort}.header`);
  writeFileSync(header, `x-sasy-hook-token: ${TOKEN}\n`);
  chmodSync(header, 0o600);
  try {
    const started = Date.now();
    const out = await runHook({ SASY_WATCH_PORT: String(hungPort), SASY_CODEX_HOOK_BUDGET: "4" });
    assert.equal(out.code, 2);
    assert.ok(Date.now() - started < 8000, "answers within the budget");
  } finally {
    rmSync(header, { force: true });
    hung.closeAllConnections?.();
    hung.close();
  }
});

test("at the end of a Codex session the daemon is told, and nothing is blocked", async () => {
  requests = [];
  status = 200;
  answer = { ok: true };
  const end = { session_id: "s1", transcript_path: "/tmp/x.jsonl", cwd: "/w", hook_event_name: "SessionEnd", reason: "other" };
  let out = await runHook({ SASY_WATCH_PORT: String(port) }, JSON.stringify(end));
  assert.equal(out.code, 0);
  assert.equal(requests[0].url, "/v1/session/end");
  assert.equal(JSON.parse(requests[0].body).agent, "codex");
  assert.equal(JSON.parse(requests[0].body).session_id, "s1");
  // A tool call whose arguments mention SessionEnd is still a tool call.
  requests = [];
  answer = { hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "[SASY] no" } };
  const sneaky = { ...CALL, tool_name: "mcp__x__y", tool_input: { hook_event_name: "SessionEnd" } };
  out = await runHook({ SASY_WATCH_PORT: String(port) }, JSON.stringify(sneaky));
  assert.equal(out.code, 2);
  assert.equal(requests[0].url, "/v1/pretooluse");
  answer = { ok: true };
  // With no daemon at all, the end still exits cleanly.
  out = await runHook({ SASY_WATCH_PORT: "9" }, JSON.stringify(end));
  assert.equal(out.code, 0);
});

test("the token is trusted with GNU stat (Linux) as well as BSD stat (macOS)", async () => {
  // A stand-in for GNU stat: `-c %a` works, `-f …` prints something and fails.
  const bin = mkdtempSync(join(tmpdir(), "gnu-stat-"));
  // The mode comes from Node, so the stand-in works on macOS and Linux alike.
  const mode = `node -e 'process.stdout.write((require("fs").statSync(process.argv[1]).mode & 0o777).toString(8))'`;
  writeFileSync(join(bin, "stat"), `#!/bin/bash\nif [ "$1" = "-c" ]; then ${mode} "$3"; else echo "  File: $2"; exit 1; fi\n`);
  chmodSync(join(bin, "stat"), 0o755);
  try {
    status = 200;
    answer = {};
    const out = await runHook({ SASY_WATCH_PORT: String(port), PATH: `${bin}:${process.env.PATH}` });
    assert.equal(out.code, 0);
  } finally {
    rmSync(bin, { recursive: true, force: true });
  }
});

test("a hook that fails for any reason still blocks the call", async () => {
  // No HOME and no SASY_HOME: nothing to find the token by, and no crash.
  const out = await new Promise((resolve) => {
    const child = spawn("bash", [HOOK], { env: { PATH: process.env.PATH, SASY_WATCH_PORT: String(port) } });
    let stderr = "";
    child.stderr.on("data", (d) => (stderr += d));
    child.on("close", (code) => resolve({ code, stderr }));
    child.stdin.end(JSON.stringify(CALL));
  });
  assert.equal(out.code, 2);
  assert.match(out.stderr, /\[SASY\] security check unavailable/);
});

test("a daemon start that hangs does not hold the hook past its budget", async () => {
  // A stand-in sasy-watch whose `ensure` never returns.
  const bin = join(home, "hang-watch");
  writeFileSync(bin, "#!/bin/bash\nexec sleep 600\n");
  chmodSync(bin, 0o755);
  const started = Date.now();
  const out = await runHook({ SASY_WATCH_PORT: "9", SASY_WATCH_BIN: bin });
  assert.equal(out.code, 2);
  assert.ok(Date.now() - started < 30000, "the hung start is cut off");
});
