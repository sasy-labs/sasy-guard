// The parts of the guard that need neither pi nor the network: reading the
// daemon's answer, counting decisions, the status and widget text, and sizing
// pushed session entries to fit the daemon's request limit.

/** What the daemon decided about one call. */
export type Decision =
  | { kind: "allow" }
  | { kind: "deny"; reason: string }
  | { kind: "ask"; reason: string };

/** One denied or asked call, kept for the widget and /guard. */
export interface DecisionRecord {
  at: number;
  tool: string;
  target: string;
  kind: "deny" | "ask";
  reason: string;
  /** For an ask: what the user chose. */
  outcome?: "approved" | "declined" | "no-ui";
}

export interface Counts {
  checked: number;
  denied: number;
  asked: number;
}

const MARKER = "[SASY]";

/**
 * Reads the daemon's /v1/pretooluse answer (a Claude Code hook output). An
 * empty object means no objection. Anything unreadable is undefined, which the
 * caller treats as no answer (fail closed).
 */
export function parseDecision(body: unknown): Decision | undefined {
  if (typeof body !== "object" || body === null || Array.isArray(body)) return undefined;
  // An error body is no decision, even with HTTP 200.
  if ("error" in body) return undefined;
  const hs = (body as { hookSpecificOutput?: unknown }).hookSpecificOutput;
  if (hs === undefined) return { kind: "allow" };
  if (typeof hs !== "object" || hs === null) return undefined;
  const { permissionDecision: d, permissionDecisionReason: r } = hs as Record<string, unknown>;
  const reason = typeof r === "string" && r.trim() !== "" ? r : `${MARKER} blocked by policy`;
  if (d === "deny") return { kind: "deny", reason };
  if (d === "ask") return { kind: "ask", reason };
  return { kind: "allow" };
}

/** The reason without the `[SASY]` marker, for display. */
export function displayReason(reason: string): string {
  const at = reason.indexOf(MARKER);
  return (at >= 0 ? reason.slice(at + MARKER.length) : reason).trim();
}

/** What a call acts on (command, path, URL), shortened for display. */
export function targetOf(input: unknown, max = 80): string {
  if (!input || typeof input !== "object") return "";
  const i = input as Record<string, unknown>;
  for (const key of ["command", "path", "url", "pattern"]) {
    const v = i[key];
    if (typeof v === "string" && v !== "") {
      const flat = v.replace(/\s+/g, " ").trim();
      return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`;
    }
  }
  return "";
}

export function statusText(c: Counts): string {
  return `sasy-guard: ${c.checked} checked · ${c.denied} denied · ${c.asked} asked`;
}

/** The widget above the editor for the latest decision: heading, reason, fix. */
export function widgetLines(d: DecisionRecord, maxReasonLines = 3): string[] {
  const verb = d.kind === "deny" ? "denied" : "asked about";
  const head = `sasy-guard ${verb} ${d.tool}${d.target ? `: ${d.target}` : ""}`;
  const outcome = d.outcome ? ` (${d.outcome})` : "";
  const lines = displayReason(d.reason)
    .split("\n")
    .filter((l) => l.trim() !== "");
  const shown = lines.slice(0, maxReasonLines);
  if (lines.length > maxReasonLines) shown.push("… full text: /guard");
  return [head + outcome, ...shown.map((l) => `  ${l}`)];
}

/** /guard's report: daemon health, the session's totals, recent decisions. */
export function guardReport(health: string, c: Counts, recent: readonly DecisionRecord[]): string {
  const lines = [health, `this session: ${c.checked} checked · ${c.denied} denied · ${c.asked} asked`];
  if (recent.length === 0) {
    lines.push("no denials or approval requests yet");
    return lines.join("\n");
  }
  lines.push("recent decisions (newest first):");
  recent.forEach((d, i) => {
    const time = new Date(d.at).toTimeString().slice(0, 8);
    lines.push(`  ${time}  ${d.kind.padEnd(4)}  ${d.tool}  ${d.target}${d.outcome ? `  (${d.outcome})` : ""}`.trimEnd());
    const reason = displayReason(d.reason).split("\n").filter((l) => l.trim() !== "");
    for (const l of i === 0 ? reason : reason.slice(0, 1)) lines.push(`            ${l}`);
  });
  return lines.join("\n");
}

/** The largest text block pushed whole; longer ones are cut (the rest elided). */
export const MAX_PUSHED_TEXT = 256 * 1024;
/** The largest request body the guard sends (the daemon accepts 4 MiB). */
export const MAX_PUSH_BYTES = 3 * 1024 * 1024;

function cutText(text: string): string {
  if (text.length <= MAX_PUSHED_TEXT) return text;
  return `${text.slice(0, MAX_PUSHED_TEXT)}\n[sasy-guard: ${text.length - MAX_PUSHED_TEXT} characters not sent]`;
}

/**
 * A copy of a session entry whose long texts are cut to MAX_PUSHED_TEXT, so
 * one large tool output cannot push a request past the daemon's limit. Images
 * are dropped (the daemon reads text only).
 */
export function shrinkEntry(entry: unknown): unknown {
  if (!entry || typeof entry !== "object") return entry;
  const e = entry as Record<string, unknown>;
  const m = e.message as Record<string, unknown> | undefined;
  if (!m || typeof m !== "object") return entry;
  const msg: Record<string, unknown> = { ...m };
  if (typeof msg.content === "string") msg.content = cutText(msg.content);
  else if (Array.isArray(msg.content)) {
    msg.content = msg.content
      .filter((b) => !(b && typeof b === "object" && (b as { type?: unknown }).type === "image"))
      .map((b) => {
        if (!b || typeof b !== "object") return b;
        const blk = b as Record<string, unknown>;
        if (typeof blk.text === "string") return { ...blk, text: cutText(blk.text) };
        // A tool call's string arguments (a write's content, say) are cut too.
        if (blk.type === "toolCall" && blk.arguments && typeof blk.arguments === "object") {
          const args = Object.fromEntries(
            Object.entries(blk.arguments as Record<string, unknown>).map(([k, v]) => [k, typeof v === "string" ? cutText(v) : v]),
          );
          return { ...blk, arguments: args };
        }
        return b;
      });
  }
  if (typeof msg.output === "string") msg.output = cutText(msg.output);
  return { ...e, message: msg };
}

/** Splits entries into batches whose JSON stays under MAX_PUSH_BYTES. */
export function batches(entries: readonly unknown[], max = MAX_PUSH_BYTES): unknown[][] {
  const out: unknown[][] = [];
  let current: unknown[] = [];
  let size = 0;
  for (const entry of entries) {
    const n = Buffer.byteLength(JSON.stringify(entry));
    if (current.length > 0 && size + n > max) {
      out.push(current);
      current = [];
      size = 0;
    }
    current.push(entry);
    size += n;
  }
  if (current.length > 0) out.push(current);
  return out;
}
