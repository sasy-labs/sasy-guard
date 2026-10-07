// The session-history feed: every row Claude Code keeps (`session.append`),
// buffered and sent to the daemon ahead of each check, so the daemon's
// dependency graph holds every earlier row when it decides. Pure, so the
// tests can hold it to its rules; the hooks module does the sending.

/** One row as the daemon's /v1/session/append takes it. */
export type FeedRow = {
  uuid: string
  agentId?: string
  message: { type: string; name?: string; role?: string; content: unknown[] }
  cwd?: string
  model?: string
  /** The tool's structured result: an object when it ran, a string when it
   *  errored or was refused (the transcript's `toolUseResult`). */
  toolUseResult?: unknown
}

/** Rows waiting to be sent, their serialized size, and how many losses of
 *  rows the daemon has not yet been told of (a count, so a loss during a push
 *  is not cleared by that push's delivery). */
export type FeedBuffer = { rows: FeedRow[]; bytes: number; gap: number }

/** At most this many rows, or serialized bytes, in one push (the daemon takes
 *  2000 rows and a 4 MiB body). */
export const MAX_BATCH_ROWS = 1000
export const MAX_BATCH_BYTES = 3_000_000
/** Past this much unsent history the buffer is dropped and the next push says
 *  rows were lost, so the daemon reads the transcript again. */
export const MAX_BUFFER_ROWS = 20_000
export const MAX_BUFFER_BYTES = 32_000_000
/** Tool results remembered for the rows that report them. */
export const MAX_RESULTS = 500

export const emptyBuffer = (): FeedBuffer => ({ rows: [], bytes: 0, gap: 0 })

/** The UTF-8 size of a string, as the daemon counts a request body. */
export function utf8Length(text: string): number {
  let bytes = 0
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i)
    if (c < 0x80) bytes += 1
    else if (c < 0x800) bytes += 2
    else if (c >= 0xd800 && c <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1)
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4 // a surrogate pair: one code point
        i++
      } else bytes += 3
    } else bytes += 3
  }
  return bytes
}

/** A row's size in a push. */
const sizeOf = (row: FeedRow): number => utf8Length(JSON.stringify(row))

/** The row for one `session.append` event, as stored. */
export function rowOf(
  e: {
    uuid: string
    agentId?: string
    message: { type: string; name?: string; role?: string; content: readonly unknown[] }
    origin?: { kind?: string; model?: unknown }
  },
  cwd: string | null | undefined,
): FeedRow {
  const { type, name, role, content } = e.message
  const model = e.origin?.kind === 'model' && typeof e.origin.model === 'string' ? e.origin.model : undefined
  return {
    uuid: e.uuid,
    ...(e.agentId === undefined ? {} : { agentId: e.agentId }),
    message: { type, ...(name === undefined ? {} : { name }), ...(role === undefined ? {} : { role }), content: [...content] },
    ...(cwd ? { cwd } : {}),
    ...(model === undefined ? {} : { model }),
  }
}

/** The buffer with one more row (appended in place); past its bounds, empty
 *  and marked lost. A row too large for any push is not kept: the buffer is
 *  marked lost instead, so the daemon reads it from the transcript. */
export function enqueue(buffer: FeedBuffer, row: FeedRow): FeedBuffer {
  const size = sizeOf(row)
  if (size > MAX_BATCH_BYTES) return { ...buffer, gap: buffer.gap + 1 }
  const bytes = buffer.bytes + size
  if (buffer.rows.length >= MAX_BUFFER_ROWS || bytes > MAX_BUFFER_BYTES) {
    return { rows: [], bytes: 0, gap: buffer.gap + 1 }
  }
  buffer.rows.push(row)
  return { rows: buffer.rows, bytes, gap: buffer.gap }
}

/** How many rows from the front can be sent: those before the first that
 *  reports a tool call still running (its result is not yet known). */
export function readyRows(rows: FeedRow[], running: ReadonlySet<string>): number {
  const held = rows.findIndex(row => resultIds(row).some(id => running.has(id)))
  return held === -1 ? rows.length : held
}

/** The tool_use ids a row's tool results answer. */
function resultIds(row: FeedRow): string[] {
  return row.message.content.flatMap(b => {
    const block = b as { type?: unknown; tool_use_id?: unknown }
    return block?.type === 'tool_result' && typeof block.tool_use_id === 'string' ? [block.tool_use_id] : []
  })
}

/**
 * Each row with the structured result of the tool call it reports, when the
 * mod saw that call finish (the transcript's `toolUseResult`). A result that
 * would make its row too large for a push is left off and `gap` set: the
 * daemon then reads that row, result and all, from the transcript first.
 */
export function withResults(
  rows: FeedRow[],
  results: ReadonlyMap<string, unknown>,
): { rows: FeedRow[]; gap: boolean } {
  let gap = false
  const out = rows.map(row => {
    if (row.toolUseResult !== undefined) return row
    const found = resultIds(row).map(id => results.get(id)).find(r => r !== undefined)
    if (found === undefined) return row
    const enriched = { ...row, toolUseResult: found }
    if (sizeOf(enriched) <= MAX_BATCH_BYTES) return enriched
    gap = true
    return row
  })
  return { rows: out, gap }
}

/** The rows split into pushes the daemon takes, in order (no row is larger
 *  than a push: enqueue keeps none). */
export function batches(rows: FeedRow[]): FeedRow[][] {
  const out: FeedRow[][] = []
  let current: FeedRow[] = []
  let size = 0
  for (const row of rows) {
    const n = sizeOf(row)
    if (current.length > 0 && (current.length >= MAX_BATCH_ROWS || size + n > MAX_BATCH_BYTES)) {
      out.push(current)
      current = []
      size = 0
    }
    current.push(row)
    size += n
  }
  if (current.length > 0) out.push(current)
  return out
}

/**
 * The buffer after a push of `pending` (a copy of the buffer taken when the
 * push began) delivered its first `sent` rows. Rows kept while the push ran stay.
 * `delivered`: the first push went through, so the daemon also learned of the
 * losses `pending` held; any since stay counted. A buffer dropped while the push ran (too much history) stays as
 * it is, marked lost.
 */
export function afterPush(now: FeedBuffer, pending: FeedBuffer, sent: number, delivered: boolean): FeedBuffer {
  // Pushes run one at a time, so `now` is `pending` plus rows kept since,
  // unless the buffer was dropped meanwhile (it no longer starts with them).
  const stillQueued = pending.rows.every((row, i) => now.rows[i] === row)
  if (!stillQueued) return now
  const rows = now.rows.slice(sent)
  return {
    rows,
    bytes: rows.reduce((n, row) => n + sizeOf(row), 0),
    gap: delivered ? now.gap - pending.gap : now.gap,
  }
}
