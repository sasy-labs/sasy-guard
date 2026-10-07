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

/** What the extension reads of a pi session entry. */
type SessionEntryLike = { id: string; parentId: string | null };
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
    /** The leaf of the branch last pushed, to notice pi moving to another branch. */
    let lastLeaf: string | null = null;
    /** The daemon may hold part of the branch only (it restarted mid-resend):
     *  the next push resends the whole branch as a reset. */
    let resetOwed = false;
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

    /** The daemon run the session's history was last pushed to. */
    let instance: string | undefined;
    /** This process's registration of the session, as the daemon names it;
     *  pushes carry it so the daemon can refuse a late push from an earlier one. */
    let generation: string | undefined;
    /** Push sequence numbers grow with the clock, so they keep growing across
     *  pi restarts that resume a session against the same daemon. */
    let lastSeq = 0;
    const nextSeq = () => (lastSeq = Math.max(lastSeq + 1, Date.now() * 1000));

    /**
     * POSTs and requires the daemon's `{ ok: true }`. Returns whether the
     * daemon is a different run from the one the history went to (it restarted
     * and lost the session), in which case the caller resends the whole branch.
     */
    async function postOk(path: string, body: unknown): Promise<boolean> {
      const out = (await client.postEnsuring(path, body)) as { ok?: unknown; instance?: unknown; generation?: unknown } | null;
      if (!out || out.ok !== true) throw new Error(`sasy-watch did not accept ${path}`);
      // Without the daemon's run id a restart could go unnoticed: no answer.
      if (typeof out.instance !== "string" || out.instance === "") throw new Error(`sasy-watch did not name its run on ${path}`);
      const changed = instance !== undefined && out.instance !== instance;
      instance = out.instance;
      // The session routes name this process's registration; without it the
      // daemon could not tell this process's requests from a replaced one's.
      if (typeof out.generation !== "string" || out.generation === "") throw new Error(`sasy-watch did not name the registration on ${path}`);
      generation = out.generation;
      return changed;
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
        .then(() => undefined)
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
        // Twice at most: a second pass resends the whole branch when the daemon
        // turns out to be a new run that lost what was pushed before.
        for (let pass = 0; pass < 2; pass++) {
          const branch = ctx.sessionManager.getBranch();
          const leaf = branch.at(-1)?.id ?? null;
          const firstFresh = branch.find((e) => !sent.has(e.id));
          // pi moved to another branch of its session tree (navigating back, or
          // continuing from an earlier entry): resend the whole branch as a reset,
          // so the daemon judges the next call by this branch's history.
          // On the second pass the daemon is a new run: resend everything as a reset.
          const jumped =
            pass === 1 ||
            resetOwed ||
            (lastLeaf !== null && (firstFresh ? (firstFresh.parentId ?? null) !== lastLeaf : leaf !== lastLeaf));
          // Whatever goes, the branches its summaries describe go before it (those
          // the daemon has not seen, unless this is a reset that rebuilds it all).
          const base = jumped ? branch : branch.filter((e) => !sent.has(e.id));
          const toSend = withSummarizedBranches(ctx, base).filter((e) => jumped || !sent.has(e.id));
          const reported = [...rejected];
          // Even with nothing new, the push goes: its answer shows whether the
          // daemon restarted (and lost the session) since the last one.
          const parts = batches(toSend.map(shrinkEntry));
          if (parts.length === 0) parts.push([]);
          let restarted = false;
          for (const [i, part] of parts.entries()) {
            restarted =
              (await postOk("/v1/session/events", {
                session_id: sessionId(ctx),
                cwd: ctx.cwd,
                ...sessionFile(ctx),
                seq: nextSeq(),
                ...(generation ? { generation } : {}),
                entries: part,
                rejected_tool_call_ids: i === 0 ? reported : [],
                reset: jumped && i === 0,
              })) || restarted;
            for (const e of part as { id: string }[]) sent.add(e.id);
          }
          if (!restarted) {
            resetOwed = false;
            lastLeaf = leaf;
            rejected = rejected.filter((id) => !reported.includes(id));
            return;
          }
          sent = new Set();
          lastLeaf = null;
        }
        // The daemon restarted again during the resend: its history may be partial.
        resetOwed = true;
        throw new Error("sasy-watch restarted while the session was being resent");
      });
      pushChain = run.catch(() => {});
      return run;
    }

    /**
     * A branch to send whole (a reset), preceded by the branches its branch
     * summaries describe: a summary depends on the branch pi left, so the
     * daemon needs that branch's entries to link the summary to them.
     */
    function withSummarizedBranches(ctx: ExtensionContext, branch: readonly SessionEntryLike[]): SessionEntryLike[] {
      const out: SessionEntryLike[] = [];
      const seen = new Set<string>();
      const add = (e: SessionEntryLike) => {
        if (!seen.has(e.id)) {
          seen.add(e.id);
          out.push(e);
        }
      };
      const summarized = (e: SessionEntryLike) =>
        (e as { type?: unknown }).type === "branch_summary" ? (e as { fromId?: unknown }).fromId : undefined;
      // Transitively, without a depth limit: a branch that was left may hold
      // summaries of older ones. Each summarized leaf is expanded once.
      const expanded = new Set<string>();
      const visit = (entries: readonly SessionEntryLike[]): void => {
        const stack: { entries: readonly SessionEntryLike[]; i: number }[] = [{ entries, i: 0 }];
        while (stack.length > 0) {
          const top = stack[stack.length - 1];
          if (top.i >= top.entries.length) {
            stack.pop();
            continue;
          }
          const e = top.entries[top.i];
          const fromId = summarized(e);
          if (typeof fromId === "string" && !expanded.has(fromId)) {
            expanded.add(fromId);
            stack.push({ entries: ctx.sessionManager.getBranch(fromId), i: 0 });
            continue; // revisit e once its summarized branch is added
          }
          add(e);
          top.i++;
        }
      };
      visit(branch);
      return out;
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
          generation,
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
      // A dialog that fails (an RPC client gone) is a refusal: the call is
      // blocked and recorded as never run.
      const choice = await ctx.ui
        .select(
          `sasy-guard: ${tool} needs your approval\n\n${target ? `${target}\n\n` : ""}${displayReason(d.reason)}`,
          [BLOCK_CHOICE, RUN_CHOICE],
        )
        .catch(() => null);
      if (choice === null) return { approved: false, outcome: "ui-error" as const };
      const approved = choice === RUN_CHOICE;
      return { approved, outcome: approved ? ("approved" as const) : ("declined" as const) };
    }

    pi.on("session_start", async (_event, ctx) => {
      sent = new Set();
      lastLeaf = null;
      generation = undefined;
      rejected = [];
      counts = { checked: 0, denied: 0, asked: 0 };
      decisions = [];
      started = undefined;
      ctx.ui.setWidget(KEY, undefined);
      show(ctx);
      try {
        await push(ctx);
      } catch (err) {
        ctx.ui.setStatus(KEY, `${statusText(counts)} · daemon did not answer (${(err as Error).message})`);
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
        const why = { "no-ui": "no UI to approve it, so it was blocked", "ui-error": "the approval dialog failed, so it was blocked", approved: "", declined: "the user declined" }[outcome];
        return { block: true, reason: `${d.reason}\n(${why})` };
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
      // Tells the daemon the call ran (approvals, detaint), before pi moves on to
      // the next call; a failure here does not change the call's result.
      await client
        .post("/v1/posttooluse", { session_id: sessionId(ctx), tool_use_id: event.toolCallId, tool_name: event.toolName, generation }, 3_000)
        .catch(() => {});
      return undefined;
    });

    pi.on("turn_end", async (_event, ctx) => {
      await push(ctx).catch(() => {});
    });

    pi.on("session_shutdown", async (_event, ctx) => {
      await push(ctx).catch(() => {});
      // The generation lets the daemon ignore this if another pi process has
      // since resumed the session.
      await client.post("/v1/session/end", { session_id: sessionId(ctx), generation }, 3_000).catch(() => {});
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
