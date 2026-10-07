import { expect, test } from 'claude-code/testing'

import { MAX_BUFFER_ROWS, MAX_DEPTH, depthOf, MAX_RESULTS, ResultTable, TOO_LARGE, afterPush, batches, emptyBuffer, enqueue, reportedCalls, utf8Length, withResults } from '../hooks/feed'

test('the feed buffer: bounded, split into pushes, and kept across a push', () => {
  const row = (uuid: string, size = 10) => ({ uuid, message: { type: 'user', content: [{ type: 'text', text: 'x'.repeat(size) }] } })
  let buffer = emptyBuffer()
  for (let i = 0; i < 3; i++) buffer = enqueue(buffer, row(`r${i}`))
  expect(buffer.rows.map(r => r.uuid)).toEqual(['r0', 'r1', 'r2'])
  // Past its bound the buffer is dropped and says rows were lost.
  let full = emptyBuffer()
  for (let i = 0; i <= MAX_BUFFER_ROWS; i++) full = enqueue(full, row(`f${i}`, 1))
  expect(full).toEqual({ rows: [], bytes: 0, gap: 1 })
  // Pushes hold at most 1000 rows and about 3 MB each, in order.
  expect(batches(Array.from({ length: 2500 }, (_, i) => row(`b${i}`, 1))).map(b => b.length)).toEqual([1000, 1000, 500])
  expect(batches([row('big1', 2_000_000), row('big2', 2_000_000)]).map(b => b.length)).toEqual([1, 1])
  // Rows kept while a push ran stay; the delivered ones go, and so does the gap.
  const pending = { ...buffer, rows: [...buffer.rows], gap: 1 }
  const now = enqueue({ ...pending, rows: [...pending.rows] }, row('r3'))
  expect(afterPush(now, pending, 2, true)).toMatchObject({ rows: [{ uuid: 'r2' }, { uuid: 'r3' }], gap: 0 })
  expect(afterPush(now, pending, 0, false).gap).toBe(1)
  // A loss while the push ran stays to be told, though the push went through.
  const lostDuring = { ...now, gap: now.gap + 1 }
  expect(afterPush(lostDuring, pending, 2, true).gap).toBe(1)
  // A buffer dropped while the push ran stays dropped.
  expect(afterPush({ rows: [], bytes: 0, gap: 2 }, pending, 2, true)).toEqual({ rows: [], bytes: 0, gap: 2 })
  // A tool result row picks up the call's structured result.
  const result = { uuid: 'x', message: { type: 'user', content: [{ type: 'tool_result', tool_use_id: 't1' }] } }
  expect(withResults([result], new Map([['t1', { exitCode: 0 }]])).rows[0]?.toolUseResult).toEqual({ exitCode: 0 })
  // An errored call's result is a string, and is sent as one.
  expect(withResults([result], new Map([['t1', 'Error: refused']])).rows[0]?.toolUseResult).toBe('Error: refused')
  // A result too large for a push is left to the transcript.
  const big = withResults([result], new Map([['t1', { out: '漢'.repeat(1_100_000) }]]))
  expect(big.rows[0]?.toolUseResult).toBeUndefined()
  expect(big.gap).toBe(true)
})

test('sizes are UTF-8 bytes, as the daemon counts a request body', () => {
  expect(utf8Length('abc')).toBe(3)
  expect(utf8Length('é')).toBe(2)
  expect(utf8Length('漢')).toBe(3)
  expect(utf8Length('😀')).toBe(4)
  // Wide text fits fewer rows in a push than its string length suggests.
  const wide = (uuid: string) => ({ uuid, message: { type: 'user', content: [{ type: 'text', text: '漢'.repeat(400_000) }] } })
  expect(batches([wide('w1'), wide('w2'), wide('w3')]).map(b => b.length)).toEqual([2, 1])
  // A row too large for any push is not kept: the buffer says rows were lost,
  // so the daemon reads it from the transcript instead.
  const huge = { uuid: 'h', message: { type: 'user', content: [{ type: 'text', text: '漢'.repeat(1_100_000) }] } }
  const kept = enqueue(enqueue(emptyBuffer(), wide('w1')), huge)
  expect(kept.rows.map(r => r.uuid)).toEqual(['w1'])
  expect(kept.gap).toBe(1)
})

test('the tool calls a push\'s rows report', () => {
  const text = (uuid: string) => ({ uuid, message: { type: 'user', content: [{ type: 'text', text: 'x' }] } })
  const result = (uuid: string, id: string) => ({ uuid, message: { type: 'user', content: [{ type: 'tool_result', tool_use_id: id }] } })
  expect(reportedCalls([text('a'), result('b', 't1'), text('c'), result('d', 't2')])).toEqual(['t1', 't2'])
})

test('a row reporting several tool calls, or a result too large, is left to the transcript', () => {
  const both = { uuid: 'x', message: { type: 'user', content: [{ type: 'tool_result', tool_use_id: 't1' }, { type: 'tool_result', tool_use_id: 't2' }] } }
  const out = withResults([both], new Map<string, unknown>([['t1', 'User rejected tool use'], ['t2', { ok: true }]]))
  expect(out.rows[0]?.toolUseResult).toBeUndefined()
  expect(out.gap).toBe(true)
  const one = { uuid: 'y', message: { type: 'user', content: [{ type: 'tool_result', tool_use_id: 't3' }] } }
  const big = withResults([one], new Map<string, unknown>([['t3', TOO_LARGE]]))
  expect(big.rows[0]?.toolUseResult).toBeUndefined()
  expect(big.gap).toBe(true)
})

test('the result table is bounded and says how many it dropped', () => {
  const table = new ResultTable()
  for (let i = 0; i < MAX_RESULTS; i++) table.note(`t${i}`, { i })
  table.note('extra', { i: -1 })
  // The oldest is dropped, and remembered: its row will go to the transcript.
  expect(table.values.has('t0')).toBe(false)
  expect(table.get('t0')).toBe(TOO_LARGE)
  expect(table.get('extra')).toEqual({ i: -1 })
  // One too large for a push is remembered the same way, not kept.
  table.note('huge', { out: '漢'.repeat(1_100_000) })
  expect(table.values.has('huge')).toBe(false)
  expect(table.get('huge')).toBe(TOO_LARGE)
  table.forget(['huge', 'extra'])
  expect(table.get('huge')).toBeUndefined()
})

test('rows and results nested deeper than the daemon parses are left to the transcript', () => {
  const nest = (n: number): unknown => (n === 0 ? 'x' : { a: nest(n - 1) })
  expect(depthOf(nest(3))).toBe(3)
  const deep = { uuid: 'd', message: { type: 'user', content: [{ type: 'text', text: 'x', extra: nest(MAX_DEPTH) }] } }
  const kept = enqueue(emptyBuffer(), deep)
  expect(kept.rows).toHaveLength(0)
  expect(kept.gap).toBe(1)
  const table = new ResultTable()
  table.note('t1', nest(MAX_DEPTH))
  expect(table.get('t1')).toBe(TOO_LARGE)
})
