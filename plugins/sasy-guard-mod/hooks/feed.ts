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
  toolUseResult?: Record<string, unknown>
}

/** Rows waiting to be sent, their serialized size, and whether rows were lost. */
export type FeedBuffer = { rows: FeedRow[]; bytes: number; gap: boolean }

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

export const emptyBuffer = (): FeedBuffer => ({ rows: [], bytes: 0, gap: false })

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

/** The buffer with one more row; past its bounds, empty and marked lost. */
export function enqueue(buffer: FeedBuffer, row: FeedRow): FeedBuffer {
  const bytes = buffer.bytes + JSON.stringify(row).length
  const rows = [...buffer.rows, row]
  if (rows.length > MAX_BUFFER_ROWS || bytes > MAX_BUFFER_BYTES) return { rows: [], bytes: 0, gap: true }
  return { rows, bytes, gap: buffer.gap }
}

/** The tool_use ids a row's tool results answer. */
function resultIds(row: FeedRow): string[] {
  return row.message.content.flatMap(b => {
    const block = b as { type?: unknown; tool_use_id?: unknown }
    return block?.type === 'tool_result' && typeof block.tool_use_id === 'string' ? [block.tool_use_id] : []
  })
}

/** Each row with the structured result of the tool call it reports, when the
 *  mod saw that call finish (the transcript's `toolUseResult`). */
export function withResults(rows: FeedRow[], results: ReadonlyMap<string, Record<string, unknown>>): FeedRow[] {
  return rows.map(row => {
    if (row.toolUseResult !== undefined) return row
    const found = resultIds(row).map(id => results.get(id)).find(r => r !== undefined)
    return found === undefined ? row : { ...row, toolUseResult: found }
  })
}

/** The rows split into pushes the daemon takes, in order. A single row larger
 *  than a push goes alone (the daemon refuses it whole if too large). */
export function batches(rows: FeedRow[]): FeedRow[][] {
  const out: FeedRow[][] = []
  let current: FeedRow[] = []
  let size = 0
  for (const row of rows) {
    const n = JSON.stringify(row).length
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
 * The buffer after a push of `pending` (the buffer as it was when the push
 * began) delivered its first `sent` rows. Rows kept while the push ran stay.
 * `delivered`: the first push went through, so the daemon also learned of any
 * lost rows. A buffer dropped while the push ran (too much history) stays as
 * it is, marked lost.
 */
export function afterPush(now: FeedBuffer, pending: FeedBuffer, sent: number, delivered: boolean): FeedBuffer {
  const stillQueued = pending.rows.every((row, i) => now.rows[i] === row)
  if (!stillQueued) return now
  const rows = now.rows.slice(sent)
  return {
    rows,
    bytes: rows.reduce((n, row) => n + JSON.stringify(row).length, 0),
    gap: delivered ? false : now.gap,
  }
}
