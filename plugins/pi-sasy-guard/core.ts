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
  outcome?: "approved" | "declined" | "no-ui" | "ui-error";
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
  // `{}` is the daemon's "no objection"; any other shape is unknown.
  if (hs === undefined) return Object.keys(body).length === 0 ? { kind: "allow" } : undefined;
  if (typeof hs !== "object" || hs === null || Array.isArray(hs)) return undefined;
  const { permissionDecision: d, permissionDecisionReason: r } = hs as Record<string, unknown>;
  const reason = typeof r === "string" && r.trim() !== "" ? r : `${MARKER} blocked by policy`;
  if (d === "deny") return { kind: "deny", reason };
  if (d === "ask") return { kind: "ask", reason };
  // No decision (an input rewrite only) or an explicit allow; any other value
  // is unknown to this extension and fails closed.
  if (d === "allow") return { kind: "allow" };
  // No decision is "no objection" only from the daemon's own output forms: an
  // input rewrite or added context. Anything else is unknown.
  const { updatedInput, additionalContext } = hs as Record<string, unknown>;
  const rewrite = typeof updatedInput === "object" && updatedInput !== null && !Array.isArray(updatedInput);
  if (d === undefined && (rewrite || typeof additionalContext === "string")) return { kind: "allow" };
  return undefined;
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

/**
 * The largest request the guard sends (the daemon's session-push route takes
 * 32 MiB). Entries go whole: the daemon cuts long text itself, in a way that
 * keeps evidence of hidden characters, so the extension must not cut first.
 */
export const MAX_PUSH_BYTES = 24 * 1024 * 1024;

/** A message's content without images, which the daemon does not read. */
function withoutImages(content: unknown): unknown {
  if (!Array.isArray(content)) return content;
  return content.filter((b) => !(b && typeof b === "object" && (b as { type?: unknown }).type === "image"));
}

/** Text kept from an entry too large to send whole (at most 4 bytes a char,
 *  so well within a request). */
const MAX_STUB_TEXT_CHARS = 2 * 1024 * 1024;

/** The text in pi message content (a string, or text blocks). */
function textOf(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((b) => (b && typeof b === "object" && (b as { type?: unknown }).type === "text" ? String((b as { text?: unknown }).text ?? "") : ""))
    .filter(Boolean)
    .join("\n");
}

/** The tool arguments policies read (paths, commands, patterns, URLs). */
const POLICY_ARGS = ["command", "path", "file_path", "notebook_path", "pattern", "url"];
/** Each policy argument's length in a stub that is still too large whole. */
const MAX_POLICY_ARG_CHARS = 4096;

/** A stubbed tool call's arguments: the ones policies read, cut to `max`. */
function policyArgs(args: unknown, max = Infinity): Record<string, string> {
  if (!args || typeof args !== "object") return {};
  const out: Record<string, string> = {};
  for (const k of POLICY_ARGS) {
    const v = (args as Record<string, unknown>)[k];
    if (typeof v === "string") out[k] = v.slice(0, max);
  }
  return out;
}

/**
 * A session entry as pushed: whole, less images and pi's own `details`
 * metadata (on the entry and its message, never inside tool arguments), and
 * less the data of other extensions' custom entries. An entry still larger
 * than a request can carry is sent as a stub that keeps its place in the tree,
 * its role, its text (cut short), its tool calls' and results' ids and names,
 * and the arguments policies read (cut short only if still too large), so the
 * push goes through and provenance survives.
 */
export function shrinkEntry(entry: unknown): unknown {
  if (!entry || typeof entry !== "object") return entry;
  const { details: _entryDetails, ...e } = entry as Record<string, unknown>;
  if (e.type === "custom" && e.customType !== "sasy-guard") {
    const { data: _data, ...rest } = e;
    return rest;
  }
  if (e.message && typeof e.message === "object") {
    const { details: _details, ...m } = e.message as Record<string, unknown>;
    e.message = { ...m, content: withoutImages(m.content) };
  }
  // A custom message and a context edit's replacement also carry content the
  // model sees.
  if ("content" in e) e.content = withoutImages(e.content);
  if (e.replacement && typeof e.replacement === "object") {
    const r = e.replacement as Record<string, unknown>;
    e.replacement = { ...r, content: withoutImages(r.content) };
  }
  if (Buffer.byteLength(JSON.stringify(e)) <= MAX_PUSH_BYTES - ENVELOPE_BYTES) return e;
  const m = (e.message ?? {}) as Record<string, unknown>;
  const note = { type: "text", text: "[sasy-guard: entry too large to send]" };
  // The text the model sees goes too, cut to a size a request can carry.
  const text = (content: unknown) => [note, { type: "text", text: textOf(content).slice(0, MAX_STUB_TEXT_CHARS) }];
  const kept = {
    ...("content" in e ? { content: text(e.content) } : {}),
    ...(e.replacement && typeof e.replacement === "object"
      ? { replacement: { content: text((e.replacement as Record<string, unknown>).content) } }
      : {}),
    ...(typeof e.summary === "string" ? { summary: e.summary.slice(0, MAX_STUB_TEXT_CHARS) } : {}),
    ...(typeof e.customType === "string" ? { customType: e.customType } : {}),
    ...(typeof e.fromId === "string" ? { fromId: e.fromId } : {}),
  };
  // The policy arguments go whole when the stub then fits, else cut short.
  const stub = (max: number) => {
    const calls = Array.isArray(m.content)
      ? m.content
          .filter((b) => b && typeof b === "object" && (b as { type?: unknown }).type === "toolCall")
          .map((b) => {
            const { id, name, arguments: args } = b as { id?: unknown; name?: unknown; arguments?: unknown };
            return { type: "toolCall", id, name, arguments: policyArgs(args, max) };
          })
      : [];
    return {
      type: e.type,
      id: e.id,
      parentId: e.parentId,
      ...kept,
      ...(e.message
        ? { message: { role: m.role, toolCallId: m.toolCallId, toolName: m.toolName, content: [...text(m.content), ...calls] } }
        : {}),
    };
  };
  const whole = stub(Infinity);
  return Buffer.byteLength(JSON.stringify(whole)) <= MAX_PUSH_BYTES - ENVELOPE_BYTES ? whole : stub(MAX_POLICY_ARG_CHARS);
}

/** Room left in each request for its other fields and the array's punctuation. */
const ENVELOPE_BYTES = 64 * 1024;

/** Splits entries into batches whose request stays under MAX_PUSH_BYTES. */
export function batches(entries: readonly unknown[], max = MAX_PUSH_BYTES): unknown[][] {
  const out: unknown[][] = [];
  let current: unknown[] = [];
  let size = 0;
  const room = Math.max(1, max - ENVELOPE_BYTES);
  for (const entry of entries) {
    const n = Buffer.byteLength(JSON.stringify(entry)) + 1; // and its comma
    if (current.length > 0 && size + n > room) {
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
