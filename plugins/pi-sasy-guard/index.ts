// sasy-guard for the pi coding agent.
//
// Checks every tool call the model makes (`tool_call`) and every `!` command
// the user types (`user_bash`) with the local sasy-watch daemon before it runs:
// a denial blocks the call and the model reads the policy's reason; an "ask"
// opens a pi dialog whose default choice blocks (and blocks where there is no UI); a check that
// gets no answer blocks the call. The daemon builds each call's history from
// the session entries this extension pushes to it, so a later action can be
// judged by where its data came from (a curl after reading .env, for one).
//
// The decisions show in the footer status, in a widget above the editor, and
// in `/guard`, which reports daemon health and the recent decisions.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { randomUUID } from "node:crypto";

import {
  batches,
  type Counts,
  type Decision,
  type DecisionRecord,
  displayReason,
  guardReport,
  parseDecision,
  shrinkEntry,
  statusText,
  targetOf,
  widgetLines,
} from "./core.ts";
import { DaemonClient } from "./daemon.ts";

const KEY = "sasy-guard";
const MAX_DECISIONS = 50;
const RECENT_IN_REPORT = 5;
const BLOCK_CHOICE = "No, block it";
const RUN_CHOICE = "Yes, run it once";

export interface GuardOptions {
  client?: DaemonClient;
  now?: () => number;
}

export function createGuard(opts: GuardOptions = {}) {
  return function sasyGuard(pi: ExtensionAPI): void {
    const client = opts.client ?? new DaemonClient();
    const now = opts.now ?? Date.now;
    let sent = new Set<string>();
    let rejected: string[] = [];
    let counts: Counts = { checked: 0, denied: 0, asked: 0 };
    let decisions: DecisionRecord[] = [];
    let pushChain: Promise<void> = Promise.resolve();
    let started: Promise<void> | undefined;

    const sessionId = (ctx: ExtensionContext) => ctx.sessionManager.getSessionId();
    /** The session file, so a daemon that restarted can rebuild the session from it. */
    const sessionFile = (ctx: ExtensionContext) => {
      const f = ctx.sessionManager.getSessionFile();
      return f ? { pi_session_file: f } : {};
    };

    /** POSTs and requires the daemon's `{ ok: true }`. */
    async function postOk(path: string, body: unknown): Promise<void> {
      const out = (await client.postEnsuring(path, body)) as { ok?: unknown } | null;
      if (!out || out.ok !== true) throw new Error(`sasy-watch did not accept ${path}`);
    }

    /**
     * Records a call pi will not run: for the next push, and as a custom session
     * entry (kept out of the model's context) so a resumed session still knows.
     */
    function reject(toolCallId: string): void {
      rejected.push(toolCallId);
      pi.appendEntry(KEY, { rejected: [toolCallId] });
    }

    /** Registers the session with the daemon (once per pi session). */
    function start(ctx: ExtensionContext): Promise<void> {
      started ??= postOk("/v1/session/start", { session_id: sessionId(ctx), cwd: ctx.cwd, agent: "pi", ...sessionFile(ctx) })
        .catch((err) => {
          started = undefined; // retried on the next check
          throw err;
        });
      return started;
    }

    /** Pushes the session entries the daemon has not seen, in order. */
    function push(ctx: ExtensionContext): Promise<void> {
      const run = pushChain.then(async () => {
        await start(ctx);
        const fresh = ctx.sessionManager.getBranch().filter((e) => !sent.has(e.id));
        const reported = [...rejected];
        if (fresh.length === 0 && reported.length === 0) return;
        const parts = batches(fresh.map(shrinkEntry));
        if (parts.length === 0) parts.push([]);
        for (const [i, part] of parts.entries()) {
          await postOk("/v1/session/events", {
            session_id: sessionId(ctx),
            cwd: ctx.cwd,
            ...sessionFile(ctx),
            entries: part,
            rejected_tool_call_ids: i === 0 ? reported : [],
          });
          for (const e of part as { id: string }[]) sent.add(e.id);
        }
        rejected = rejected.filter((id) => !reported.includes(id));
      });
      pushChain = run.catch(() => {});
      return run;
    }

    function show(ctx: ExtensionContext, latest?: DecisionRecord): void {
      ctx.ui.setStatus(KEY, statusText(counts));
      if (latest) ctx.ui.setWidget(KEY, widgetLines(latest));
    }

    function record(ctx: ExtensionContext, d: Decision, tool: string, input: unknown, outcome?: DecisionRecord["outcome"]) {
      counts = {
        checked: counts.checked + 1,
        denied: counts.denied + (d.kind === "deny" ? 1 : 0),
        asked: counts.asked + (d.kind === "ask" ? 1 : 0),
      };
      if (d.kind === "allow") return show(ctx);
      const rec: DecisionRecord = { at: now(), tool, target: targetOf(input), kind: d.kind, reason: d.reason, ...(outcome ? { outcome } : {}) };
      decisions = [...decisions, rec].slice(-MAX_DECISIONS);
      show(ctx, rec);
    }

    /**
     * The policy's answer on one call, after pushing what came before it. Any
     * failure is a denial (fail closed), unless SASY_FAIL_OPEN=true.
     */
    async function decide(ctx: ExtensionContext, toolName: string, input: unknown, toolCallId: string): Promise<Decision> {
      try {
        await push(ctx);
        const out = await client.postEnsuring("/v1/pretooluse", {
          session_id: sessionId(ctx),
          agent: "pi",
          tool_name: toolName,
          tool_input: input ?? {},
          tool_use_id: toolCallId,
          cwd: ctx.cwd,
          ...sessionFile(ctx),
        });
        const d = parseDecision(out);
        if (d) return d;
        throw new Error("sasy-watch gave an answer that is not a decision");
      } catch (err) {
        if (process.env.SASY_FAIL_OPEN === "true") return { kind: "allow" };
        return { kind: "deny", reason: `[SASY] security check unavailable (${(err as Error).message})` };
      }
    }

    /**
     * Settles an "ask" with a pi dialog whose first (default) choice blocks, so
     * Enter never runs the call; with no UI the call is blocked.
     */
    async function settleAsk(ctx: ExtensionContext, d: Decision & { kind: "ask" }, tool: string, input: unknown) {
      if (!ctx.hasUI) return { approved: false, outcome: "no-ui" as const };
      const target = targetOf(input, 200);
      const choice = await ctx.ui.select(
        `sasy-guard: ${tool} needs your approval\n\n${target ? `${target}\n\n` : ""}${displayReason(d.reason)}`,
        [BLOCK_CHOICE, RUN_CHOICE],
      );
      const approved = choice === RUN_CHOICE;
      return { approved, outcome: approved ? ("approved" as const) : ("declined" as const) };
    }

    pi.on("session_start", async (_event, ctx) => {
      sent = new Set();
      rejected = [];
      counts = { checked: 0, denied: 0, asked: 0 };
      decisions = [];
      started = undefined;
      ctx.ui.setWidget(KEY, undefined);
      show(ctx);
      try {
        await push(ctx);
      } catch {
        ctx.ui.setStatus(KEY, `${statusText(counts)} · daemon unreachable`);
      }
    });

    pi.on("tool_call", async (event, ctx) => {
      const d = await decide(ctx, event.toolName, event.input, event.toolCallId);
      if (d.kind === "allow") {
        record(ctx, d, event.toolName, event.input);
        return undefined;
      }
      if (d.kind === "ask") {
        const { approved, outcome } = await settleAsk(ctx, d, event.toolName, event.input);
        record(ctx, d, event.toolName, event.input, outcome);
        if (approved) return undefined;
        reject(event.toolCallId);
        return { block: true, reason: outcome === "no-ui" ? `${d.reason}\n(no UI to approve it, so it was blocked)` : `${d.reason}\n(the user declined)` };
      }
      record(ctx, d, event.toolName, event.input);
      reject(event.toolCallId);
      return { block: true, reason: d.reason };
    });

    // `!` commands the user types run outside tool_call; check them too.
    pi.on("user_bash", async (event, ctx) => {
      const input = { command: event.command };
      const d = await decide(ctx, "bash", input, `user-bash-${randomUUID()}`);
      let blocked = d.kind === "deny";
      let outcome: DecisionRecord["outcome"];
      if (d.kind === "ask") {
        const settled = await settleAsk(ctx, d, "bash", input);
        blocked = !settled.approved;
        outcome = settled.outcome;
      }
      record(ctx, d, "bash", input, outcome);
      if (!blocked) return undefined;
      return { result: { output: `${d.kind === "allow" ? "" : d.reason}\n`, exitCode: 1, cancelled: false, truncated: false } };
    });

    pi.on("tool_result", async (event, ctx) => {
      // Best effort: tells the daemon the call ran (approvals, detaint).
      client
        .post("/v1/posttooluse", { session_id: sessionId(ctx), tool_use_id: event.toolCallId, tool_name: event.toolName })
        .catch(() => {});
      return undefined;
    });

    pi.on("turn_end", async (_event, ctx) => {
      await push(ctx).catch(() => {});
    });

    pi.on("session_shutdown", async (_event, ctx) => {
      await push(ctx).catch(() => {});
      await client.post("/v1/session/end", { session_id: sessionId(ctx) }, 3_000).catch(() => {});
    });

    pi.registerCommand("guard", {
      description: "sasy-guard: daemon health and recent policy decisions (`/guard clear` hides the widget)",
      handler: async (args, ctx) => {
        if (args.trim() === "clear") {
          ctx.ui.setWidget(KEY, undefined);
          return;
        }
        const recent = decisions.slice(-RECENT_IN_REPORT).reverse();
        ctx.ui.notify(guardReport(await client.health(), counts, recent), "info");
      },
    });
  };
}

export default createGuard();
