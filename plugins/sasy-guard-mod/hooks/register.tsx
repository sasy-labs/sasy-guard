// sasy-guard-mod: SASY policy enforcement for Claude Code, as a mod.
//
// A standalone alternative to the sasy-guard hook plugin (install one or the
// other). Talking to the same local sasy-watch daemon, it does what that
// plugin's settings hooks do, from inside Claude Code: at SessionStart it starts
// the daemon if needed and registers the session; at classic.PreToolUse it
// asks the daemon about each tool call (enforce.ts builds the request) and
// denies it, asks the user, or lets it go on to any other settings hooks; at
// PostToolUse it sends the daemon its post-tool signal; at SessionEnd it ends
// the session. It fails closed: no answer from the daemon, or a call whose
// caller it cannot name (agents.ts), is denied.
//
// It also draws the decisions: a status line with the session's counts, a band
// above the prompt for the latest denial or approval request, and a `/guard`
// command that answers at once, with no model turn.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, PreToolUseResult, Register } from 'claude-code'

import type { GuardDecision, GuardSessionInfo, GuardVerdict } from '../types'
import type { AgentTable } from './agents'
import type { Carried } from './carry'
import { addSpawn, attribute, markUnattributable, isolatedWorktreeAgent } from './agents'
import { MAX_DECISIONS, addCounts, joinDecisions } from './carry'
import type { FeedBuffer, FeedRow } from './feed'
import {
  ResultTable,
  afterPush,
  agentsOf,
  batches,
  emptyBuffer,
  enqueue,
  isAcknowledged,
  reportedCalls,
  rowOf,
  withResults,
} from './feed'
import type { BypassOffer, CheckAnswer, CheckInput } from './enforce'
import {
  ENDPOINT,
  FAIL_MODES,
  MARKER,
  SESSION_NOTE,
  choiceLabels,
  cleanOffer,
  bandLines,
  cleanReason,
  guardText,
  shorten,
  statusText,
  targetOf,
  verdictOf,
} from './text'
import {
  CHECK_TIMEOUT_MS,
  DEFAULT_PORT,
  ENSURE_TIMEOUT_MS,
  checkArgv,
  combine,
  denyWith,
  parseAnswer,
  postArgv,
  splitStatus,
} from './enforce'

const PLUGIN = 'sasy-guard'
const COMMAND = 'guard'
/** The most worktree ids seen before their spawn that the mod remembers. */
const MAX_EARLY = 200
const HEALTH_TIMEOUT_MS = 3000
/** How long a history push waits for a reported tool call to finish. */
const RESULT_WAIT_MS = 5000
/** The denial for a check whose history did not reach the daemon. */
const HISTORY_UNSENT =
  '[SASY] security check unavailable: the session history could not be sent to the sasy-watch daemon'
/** Pushes before a check: the first, then rounds for rows kept meanwhile. */
const MAX_PUSH_ROUNDS = 3
/** The most time a check spends sending history, all rounds included: room
 *  for one timed-out request, one daemon start, and a retry. */
const PUSH_DEADLINE_MS = 30_000

const counts = atom({ plugin: 'sasy-guard-mod', key: 'counts' } as const, {
  checked: 0,
  denied: 0,
  asked: 0,
})
const decisions = atom({ plugin: 'sasy-guard-mod', key: 'decisions' } as const, [])
const dismissedSeq = atom({ plugin: 'sasy-guard-mod', key: 'dismissedSeq' } as const, 0)
const compactMark = atom({ plugin: 'sasy-guard-mod', key: 'compactMark' } as const, 0)
const sessionInfo = atom(
  { plugin: 'sasy-guard-mod', key: 'sessionInfo' } as const,
  null as GuardSessionInfo | null,
)

async function sasyHome($: EngineInterface): Promise<string> {
  return (await $.env.get('SASY_HOME')) || `${await $.env.get('HOME')}/.sasy`
}

/** The port the daemon listens on, or undefined when the setting is no port. */
async function daemonPort($: EngineInterface): Promise<string | undefined> {
  const port = (await $.env.get('SASY_WATCH_PORT')) || DEFAULT_PORT
  return /^[0-9]{1,5}$/.test(port) ? port : undefined
}

/** The hook-auth header file a daemon that authenticates hooks writes (lib.sh). */
async function authHeaderFile($: EngineInterface, port: string): Promise<string | undefined> {
  const path = `${await sasyHome($)}/hook-auth-${port}.header`
  try {
    const st = await $.fs.stat(path)
    return st.kind === 'file' && !st.isLink ? path : undefined
  } catch {
    return undefined
  }
}

/** curl exits that mean the daemon did not answer: could not connect (7),
 *  partial reply (18), timed out (28), empty reply (52), the connection dropped
 *  while sending (55) or receiving (56). */
const UNREACHABLE_CURL_EXITS = [7, 18, 28, 52, 55, 56]

/** A check's reply: the daemon's body, or why there is none and of what kind. */
type CheckReply = { body: string } | { error: string; kind: 'unreachable' | 'auth' | 'answer' }

/** One POST to /v1/pretooluse; the answer's body, or why there is none. */
async function postCheck(
  $: EngineInterface,
  port: string,
  input: CheckInput,
): Promise<CheckReply> {
  const argv = checkArgv(port, await authHeaderFile($, port))
  let ran: { exitCode: number; stdout: string }
  try {
    ran = await $.process.run(argv, { stdin: JSON.stringify(input), timeoutMs: CHECK_TIMEOUT_MS })
  } catch {
    // curl did not run at all: nothing is known about the daemon.
    return { error: 'could not run curl', kind: 'answer' }
  }
  if (ran.exitCode !== 0) {
    // Only a daemon that is down or not answering is "unreachable" (the one
    // failure SASY_FAIL_OPEN covers); curl failing otherwise, as on an auth
    // header file it cannot read, is not.
    const kind = UNREACHABLE_CURL_EXITS.includes(ran.exitCode) ? 'unreachable' : 'answer'
    return { error: `curl exit ${ran.exitCode} on port ${port}`, kind }
  }
  const { body, status } = splitStatus(ran.stdout)
  if (status === '200') return { body }
  const kind = status === '401' || status === '403' ? 'auth' : 'answer'
  return { error: `sasy-watch answered HTTP ${status}`, kind }
}

/** Starts the daemon if it is down, as the settings hook's lib.sh does. */
async function ensureDaemon($: EngineInterface): Promise<void> {
  const bin = (await $.env.get('SASY_WATCH_BIN')) || `${await sasyHome($)}/bin/sasy-watch`
  try {
    await $.process.run([bin, 'ensure', '--wait-ms', '6000'], { timeoutMs: ENSURE_TIMEOUT_MS })
  } catch {
    // Not installed, or it did not start: the retry then fails closed.
  }
}

/**
 * The policy's answer on one call. Fails closed: when the daemon cannot be
 * reached after one attempt to start it, the call is denied, unless
 * SASY_FAIL_OPEN=true, as for the settings hook.
 */
/** Whether an unreachable daemon lets calls through: SASY_FAIL_OPEN=true and,
 *  as in the hook, the daemon's hook-auth file in place. */
async function failsOpen($: EngineInterface): Promise<boolean> {
  const port = await daemonPort($)
  return (
    port !== undefined &&
    (await $.env.get('SASY_FAIL_OPEN')) === 'true' &&
    (await authHeaderFile($, port)) !== undefined
  )
}

async function checkCall($: EngineInterface, input: CheckInput): Promise<CheckAnswer> {
  // Mirrors the hook plugin's pretooluse.sh, which this mod replaces.
  const port = await daemonPort($)
  let answer: CheckReply =
    port === undefined
      ? { error: 'SASY_WATCH_PORT is not a port number', kind: 'answer' }
      : await postCheck($, port, input)
  if ('error' in answer && answer.kind === 'unreachable' && port !== undefined) {
    await ensureDaemon($)
    answer = await postCheck($, port, input)
  }
  const parsed = 'body' in answer ? parseAnswer(answer.body) : undefined
  if (parsed !== undefined) return parsed
  // SASY_FAIL_OPEN covers an unreachable daemon only, and, as in the hook,
  // only with the daemon's hook-auth file in place: never a refused or missing
  // authentication, nor an answer that is no decision.
  const isDown = 'error' in answer && answer.kind === 'unreachable'
  if (isDown && (await failsOpen($))) return { result: {} }
  const why = 'error' in answer ? answer.error : 'sasy-watch gave an answer that is not a decision'
  return { result: { deny: `[SASY] security check unavailable (${why})` } }
}

/** Whether a person can be asked: some surface draws the session. */
async function canAsk($: EngineInterface): Promise<boolean> {
  return (await $.session.surfaces()).length > 0
}

/** What became of one approval dialog: the call's result and what to record. */
/** `record` is absent when the outcome is an ordinary SASY denial. */
type DialogOutcome = { result: PreToolUseResult; record?: DialogRecord }

/**
 * The mod's own approval dialog for a one-time bypass the daemon offered. It
 * holds the call while it asks, records the answer with the daemon
 * (/v1/approval, bound to this call's tool_use_id and offer), and on approval
 * checks the call again: the daemon then allows it once, unless what the
 * decision rested on changed, in which case the new offer is shown once more.
 * A dismissed dialog declines. Replaces the model-driven AskUserQuestion round
 * trip; the model reads only the outcome.
 */
async function askForBypass(
  $: EngineInterface,
  input: CheckInput,
  offer: BypassOffer,
  check: (input: CheckInput) => Promise<CheckAnswer>,
  attemptsLeft = 1,
): Promise<DialogOutcome> {
  return askAbout($, input, cleanOffer(offer), check, attemptsLeft)
}

async function askAbout(
  $: EngineInterface,
  input: CheckInput,
  offer: BypassOffer,
  check: (input: CheckInput) => Promise<CheckAnswer>,
  attemptsLeft: number,
): Promise<DialogOutcome> {
  const labels = choiceLabels(offer)
  const question = offer.question.replace(/\s*\[SASY-ALLOW:[0-9a-f]+\]\s*$/, '')
  let answer = labels.decline ?? 'Deny'
  try {
    answer = await $.ui.ask(question, {
      header: 'SASY',
      options: offer.labels.map(label => labels[label] ?? label),
    })
  } catch {
    // Dismissed: the call stays blocked.
  }
  const choice =
    Object.entries(labels).find(([, label]) => label === answer)?.[0] ?? 'decline'
  const recorded = await postBestEffort(
    $,
    '/v1/approval',
    { session_id: input.session_id, tool_use_id: input.tool_use_id, choice },
    5,
  )
  let isRecorded = false
  try {
    isRecorded = recorded !== undefined && (JSON.parse(recorded) as { ok?: unknown }).ok === true
  } catch {
    // Not the daemon's answer: nothing was recorded.
  }
  const policy = offer.policyReason.replace(MARKER, '').trim()
  if (choice === 'decline') {
    return {
      result: {
        deny:
          '[SASY] The user declined a one-time bypass of this check. Follow the ' +
          `suggested fix instead of retrying the same action.\n\n${policy}`,
      },
      record: { verdict: 'declined', reason: `${offer.reason} — you denied it` },
    }
  }
  if (!isRecorded) {
    // No answer is not proof that nothing changed: the daemon may have applied
    // the choice before the connection failed, so say both.
    const maybeTrusted =
      choice === 'trust-domain'
        ? [`The SASY daemon may have recorded the user's choice to trust ${offer.domain ?? 'this host'} for this session.`]
        : []
    return {
      result: {
        deny: `[SASY] The approval could not be confirmed, so the action stays blocked.\n\n${policy}`,
        ...(maybeTrusted.length === 0 ? {} : { additionalContext: maybeTrusted }),
      },
      record: { verdict: 'declined', reason: `${offer.reason} — your choice could not be confirmed (it may still have taken effect)` },
    }
  }
  // What the user chose here, kept in the record whatever follows: a trusted
  // host stays trusted for the session even if the call is then blocked.
  const chosen =
    choice === 'trust-domain'
      ? `${offer.reason} — you trusted ${offer.domain ?? 'the host'} for this session`
      : `${offer.reason} — you approved it once`
  const trustNote =
    choice === 'trust-domain'
      ? `The user chose in the SASY dialog to trust ${offer.domain ?? 'this host'} for the rest ` +
        'of this session.'
      : undefined
  // Checked again with the history kept while the dialog was open.
  const again = await check(input)
  // The re-check's own verdict (a new ask, or a plain denial on new evidence),
  // recorded after what the user chose, which the model is also told of.
  const after = (verdict: GuardVerdict, text: string): DialogOutcome => ({
    result: trustNote
      ? { ...again.result, additionalContext: [...(again.result.additionalContext ?? []), trustNote] }
      : again.result,
    record: { verdict, reason: `${chosen}; then ${cleanReason(text.slice(Math.max(text.indexOf(MARKER), 0)).replace(MARKER, ''))}` },
  })
  // A new approval requirement: Claude Code asks the user, as for any ask.
  if (again.result.ask !== undefined) return after('ask', again.result.ask)
  if (again.result.deny !== undefined) {
    // The decision's grounds changed since the question: ask about the new one.
    if (again.offer !== undefined && attemptsLeft > 0) {
      const later = await askForBypass($, input, again.offer, check, attemptsLeft - 1)
      const context = [...(later.result.additionalContext ?? []), ...(trustNote ? [trustNote] : [])]
      const laterReason = later.record?.reason ?? `blocked: ${cleanReason(later.result.deny ?? '')}`
      return {
        result: context.length === 0 ? later.result : { ...later.result, additionalContext: context },
        record: { verdict: later.record?.verdict ?? 'declined', reason: `${chosen}; then ${laterReason}` },
      }
    }
    if (again.offer !== undefined) {
      // It changed again: stop asking, keep the call blocked, and say why.
      // The newest offer is declined at the daemon, so no later question can
      // approve it.
      await postBestEffort(
        $,
        '/v1/approval',
        { session_id: input.session_id, tool_use_id: input.tool_use_id, choice: 'decline' },
        5,
      )
      const changed = cleanOffer(again.offer)
      const fix = changed.policyReason.replace(MARKER, '').trim()
      return {
        result: {
          deny:
            '[SASY] The decision changed again after the user approved it, so the action ' +
            `stays blocked.\n\n${fix}`,
          ...(trustNote ? { additionalContext: [trustNote] } : {}),
        },
        record: {
          verdict: 'declined',
          reason: `${chosen}; then ${changed.reason} — changed again after your approval`,
        },
      }
    }
    // A plain denial now (new evidence): recorded as the denial it is.
    return after('deny', again.result.deny)
  }
  const note = trustNote
    ? `${trustNote} This action may proceed.`
    : 'The user approved a one-time bypass of a SASY check for this action in the SASY dialog.'
  return {
    result: { ...again.result, additionalContext: [...(again.result.additionalContext ?? []), note] },
    record: { verdict: 'approved', reason: chosen },
  }
}

/**
 * One line on the sasy-watch daemon, from its /healthz route.
 *
 * Read with curl so the request has a hard time and size limit: the port is
 * plain HTTP on loopback, and anything holding it can answer. The answer is
 * printed into the transcript, which the model reads, so only values in the
 * daemon's own shapes are printed.
 */
async function daemonHealth($: EngineInterface): Promise<string> {
  const port = await daemonPort($)
  if (port === undefined) return `daemon: SASY_WATCH_PORT is not a port number`
  const url = `http://127.0.0.1:${port}/healthz`
  // --noproxy: loopback never goes via a proxy. --write-out appends the HTTP
  // status on a line of its own; the daemon answers /healthz with 200.
  const argv = [
    'curl', '-sS', '--noproxy', '*', '--max-time', '2', '--max-filesize', '65536',
    '--write-out', '\n%{http_code}', url,
  ]
  let ran: { exitCode: number; stdout: string }
  try {
    ran = await $.process.run(argv, { timeoutMs: HEALTH_TIMEOUT_MS })
  } catch {
    return `daemon: could not run curl to reach ${url}`
  }
  if (ran.exitCode !== 0) return `daemon: unreachable at ${url} (curl exit ${ran.exitCode})`
  const cut = ran.stdout.lastIndexOf('\n')
  const status = ran.stdout.slice(cut + 1)
  if (!/^[0-9]{3}$/.test(status)) return `daemon: ${url} gave no HTTP status`
  if (status !== '200') return `daemon: ${url} answered HTTP ${status}`
  let h: unknown
  try {
    h = JSON.parse(ran.stdout.slice(0, Math.max(cut, 0)))
  } catch {
    return `daemon: ${url} answered with a body that is not JSON`
  }
  const r = (typeof h === 'object' && h !== null ? h : {}) as Record<string, unknown>
  const isDaemon =
    r.ok === true &&
    typeof r.ready === 'boolean' &&
    typeof r.endpoint === 'string' &&
    ENDPOINT.test(r.endpoint) &&
    typeof r.failMode === 'string' &&
    FAIL_MODES.includes(r.failMode) &&
    Number.isInteger(r.sessions) &&
    (r.sessions as number) >= 0
  if (!isDaemon) return `daemon: ${url} answered, but not as the sasy-watch daemon`
  const state = r.ready ? 'up, policy engine ready' : 'up, policy engine not ready'
  return (
    `daemon: ${state} · endpoint ${r.endpoint} · ` +
    `fail mode ${r.failMode} · ${r.sessions} session(s)`
  )
}

/** What the mod's own dialog came to, for the record: the offer the user
 *  answered (its reason) and whether they approved. */
type DialogRecord = { verdict: GuardVerdict; reason: string }

/** Counts one checked call and keeps it when it carries a [SASY] verdict, or
 *  when the mod's own dialog asked the user about it. */
async function record(
  $: EngineInterface,
  e: Readonly<Record<string, unknown>>,
  result: PreToolUseResult,
  dialog?: DialogRecord,
): Promise<void> {
  const found = dialog ?? verdictOf(result)
  const total = await update($, counts, c => ({
    checked: c.checked + 1,
    denied: c.denied + (found?.verdict === 'deny' ? 1 : 0),
    asked: c.asked + (found?.verdict === 'ask' || dialog !== undefined ? 1 : 0),
  }))
  $.ui.status(statusText(total))
  if (found === null) return
  const at = await $.clock.now()
  await update($, decisions, list => {
    const seq = (list[list.length - 1]?.seq ?? 0) + 1
    const decision: GuardDecision = { seq, at, tool: String(e.tool), target: targetOf(e), ...found }
    return [...list, decision].slice(-MAX_DECISIONS)
  })
}

/**
 * record(), never throwing: it runs after `next`, where a failure would hand
 * the call to the .catch handler, which denies it.
 */
async function recordSafely(
  $: EngineInterface,
  e: unknown,
  result: PreToolUseResult,
  dialog?: DialogRecord,
): Promise<void> {
  try {
    await record($, e as Readonly<Record<string, unknown>>, result, dialog)
  } catch {
    // The counts and the band miss one call; the decision stands.
  }
}

/** What became of sending the session-history feed. */
type FeedOutcome = 'sent' | 'unsupported' | 'unreachable' | 'failed'

/**
 * Sends buffered history rows to the daemon (/v1/session/append), in pushes it
 * takes, in order. `unsupported`: the daemon has no such route (a released
 * daemon, which reads the transcript instead). `sent` counts the rows that
 * reached it, so a failed push leaves the rest buffered.
 */
async function sendFeed(
  $: EngineInterface,
  base: { session_id: string; transcript_path?: string; cwd: string },
  rows: FeedRow[],
  agents: Record<string, { toolUseId: string; agentType: string }>,
  gap: boolean,
  deadline: number,
): Promise<{ outcome: FeedOutcome; sent: number }> {
  const port = await daemonPort($)
  if (port === undefined) return { outcome: 'failed', sent: 0 }
  const auth = await authHeaderFile($, port)
  let sent = 0
  for (const batch of batches(rows).concat(rows.length === 0 && gap ? [[]] : [])) {
    // One deadline for all of a check's pushing: each request gets only the
    // time left, so a slow port holder cannot hold the call for longer.
    const left = deadline - (await $.clock.now())
    if (left < 1000) return { outcome: 'failed', sent }
    const seconds = Math.min(10, Math.floor(left / 1000))
    const ran = await $.process.run(postArgv(port, auth, '/v1/session/append', seconds), {
      stdin: JSON.stringify({ ...base, rows: batch, agents: agentsOf(batch, agents), gap: gap && sent === 0 }),
      timeoutMs: seconds * 1000 + 500,
    })
    if (ran.exitCode !== 0) {
      return { outcome: UNREACHABLE_CURL_EXITS.includes(ran.exitCode) ? 'unreachable' : 'failed', sent }
    }
    const { body, status } = splitStatus(ran.stdout)
    if (status === '404') return { outcome: 'unsupported', sent }
    if (!isAcknowledged(status, body)) return { outcome: 'failed', sent }
    sent += batch.length
  }
  return { outcome: 'sent', sent }
}

/**
 * One best-effort POST to a daemon route (session start and end, the post-tool
 * signal), with the hook-auth header when the daemon wrote one. Resolves to the
 * answer's body on HTTP 200, else undefined; never throws.
 */
async function postBestEffort(
  $: EngineInterface,
  route: string,
  body: unknown,
  maxSeconds: number,
  retrySeconds = 0,
): Promise<string | undefined> {
  try {
    const port = await daemonPort($)
    if (port === undefined) return undefined
    const argv = postArgv(port, await authHeaderFile($, port), route, maxSeconds, retrySeconds)
    const ran = await $.process.run(argv, {
      stdin: JSON.stringify(body),
      timeoutMs: (maxSeconds + retrySeconds + 3) * 1000,
    })
    if (ran.exitCode !== 0) return undefined
    const { body: answer, status } = splitStatus(ran.stdout)
    return status === '200' ? answer : undefined
  } catch {
    return undefined
  }
}

/** The `additionalContext` a daemon answer carries, if any. */
function contextOf(answer: string | undefined): string[] {
  if (answer === undefined) return []
  try {
    const out = JSON.parse(answer) as { hookSpecificOutput?: { additionalContext?: unknown } }
    const note = out.hookSpecificOutput?.additionalContext
    return typeof note === 'string' && note !== '' ? [note] : []
  } catch {
    return []
  }
}

/** Marks the mod's values and reads them, just before compaction. */
async function snapshot($: EngineInterface): Promise<Carried> {
  const mark = await $.clock.now()
  await update($, compactMark, () => mark)
  return {
    counts: await read($, counts),
    decisions: await read($, decisions),
    dismissedSeq: await read($, dismissedSeq),
    mark,
  }
}

/**
 * Puts back what compaction cleared, merged with anything recorded since: each
 * write applies to the value as it then stands, so a concurrent record is
 * kept. Nothing happens when the values were not cleared.
 */
async function restore($: EngineInterface, kept: Carried): Promise<void> {
  // The mark is still there: compaction left the values alone.
  if ((await read($, compactMark)) === kept.mark) return
  const total = await update($, counts, now => addCounts(kept.counts, now))
  await update($, decisions, now => joinDecisions(kept.decisions, now))
  await update($, dismissedSeq, now => Math.max(now, kept.dismissedSeq))
  $.ui.status(statusText(total))
}

export const register: Register = on => {
  // Hooks that only observe carry no .catch: one that fails before next is
  // skipped, and one that fails after next leaves next's result standing.
  // Whether /guard registered; if another plugin owns the name, pass it on.
  let ownsCommand = false
  // The subagent behind each call in flight, by tool_use_id: tool.call knows
  // it, classic.PreToolUse does not. And the Agent calls that asked for a
  // worktree of their own, by tool_use_id, until their spawn is recorded.
  const callerOf = new Map<string, string>()
  const isolatedCalls = new Set<string>()
  // The subagents seen this session (agents.ts), and the ids whose worktree
  // appeared before their spawn finished. Held in this module's memory, which
  // /clear, /resume and compaction leave alone (only a reload of the mod
  // clears it, after which running subagents are denied as unknown), and
  // written synchronously, so no other event can interleave with a write.
  let agentTable: AgentTable = {}
  let earlyWorktrees: string[] = []
  // The session-history feed: rows Claude Code kept since the last push, the
  // structured results of finished tool calls (sent with the rows reporting
  // them), what each subagent's spawn said, and whether the daemon takes the
  // feed at all (a released daemon does not; it reads the transcript).
  // The session the buffered rows belong to: /clear, /resume and /branch move
  // to another, whose history starts afresh.
  let feedSession: string | undefined
  // Bumped with each new session, so a push in flight across the change
  // leaves the new buffer alone.
  let feedGeneration = 0
  let feed: FeedBuffer = emptyBuffer()
  // The session's folder as last read (at session start, each check and
  // after each main-thread tool call).
  let knownCwd: string | undefined
  let feedSupported = true
  const toolResults = new ResultTable()
  // Tool calls started and not yet finished, by tool_use_id, each with what
  // ends its wait.
  const running = new Map<string, { done: Promise<void>; finish: () => void }>()
  const start = (id: string): void => {
    let finish = (): void => {}
    const done = new Promise<void>(resolve => (finish = resolve))
    running.set(id, { done, finish })
  }
  const stop = (id: string): void => {
    running.get(id)?.finish()
    running.delete(id)
  }
  // The history push in flight, which the next check waits for.
  let pushInFlight: Promise<void> | undefined
  const spawns: Record<string, { toolUseId: string; agentType: string }> = {}
  // The totals and decisions as they stood before the last compaction, put
  // back by classic.SessionStart if compaction cleared them.
  let carried: Carried | undefined

  on('session.start', async ($, e, next) => {
    $.ui.status(statusText(await read($, counts)))
    try {
      await $.command.register({
        name: COMMAND,
        description: 'Show sasy-guard daemon health and recent policy decisions',
        immediate: true,
      })
      ownsCommand = true
    } catch (error) {
      // Another plugin may own the name; the status line and band still work.
      const why = error instanceof Error ? error.message : String(error)
      $.ui.toast(`sasy-guard: /${COMMAND} is unavailable (${shorten(why, 120)})`)
    }
    return next(e)
  })

  // Fires at startup and after /clear, /resume, /branch and compaction: as the
  // hook plugin's session-start script, start the daemon if needed and
  // register the session (a fresh registration after /clear). The resets also
  // clear $.state without a new session.start: after compaction put back
  // what was carried, re-pin the status line and keep what each check needs
  // to say about the session.
  on('classic.SessionStart', async ($, e, next) => {
    // Another session's rows: after /clear, /resume or /branch, also when the
    // mod first saw this one start there (it was enabled mid-session).
    const isOther =
      feedSession === undefined ? e.source !== 'startup' && e.source !== 'compact' : feedSession !== e.session_id
    if (isOther) {
      feed = emptyBuffer()
      feedSupported = true
      toolResults.clear()
      feedGeneration++
    }
    feedSession = e.session_id
    if (typeof e.cwd === 'string' && e.cwd !== '') knownCwd = e.cwd
    const kept = carried
    carried = undefined
    if (kept !== undefined && e.source === 'compact') {
      try {
        await restore($, kept)
      } catch {
        // The totals and the band start over; enforcement is unaffected.
      }
    }
    const path = typeof e.transcript_path === 'string' ? e.transcript_path : ''
    const type = typeof e.agent_type === 'string' ? e.agent_type : ''
    await update($, sessionInfo, () => ({
      transcriptPath: path === '' ? null : path,
      agentType: type === '' ? null : type,
    }))
    $.ui.status(statusText(await read($, counts)))
    let isRegistered = (await postBestEffort($, '/v1/session/start', e, 10)) !== undefined
    if (!isRegistered) {
      // A daemon just started answers before its policy engine is ready:
      // retry the registration for up to 20 seconds while the engine starts.
      // Bounded so a port holder that never answers delays the start by at
      // most about 45 seconds (10 + the daemon start + 20 + one attempt).
      await ensureDaemon($)
      isRegistered = (await postBestEffort($, '/v1/session/start', e, 5, 20)) !== undefined
    }
    if (!isRegistered) {
      $.ui.toast(
        'sasy-guard: the SASY daemon did not start; tool calls will be blocked ' +
          '(unless SASY_FAIL_OPEN=true with the hook-auth file in place)',
      )
    }
    const result = await next(e)
    return { ...result, additionalContext: [...(result.additionalContext ?? []), SESSION_NOTE] }
  })

  // The daemon's post-tool signal: the call ran (its approval recorder's
  // evidence) and, for AskUserQuestion, the answer. Best effort, as the hook's.
  on('classic.PostToolUse', async ($, e, next) => {
    const context = contextOf(await postBestEffort($, '/v1/posttooluse', e, 5))
    const result = await next(e)
    if (context.length === 0) return result
    return { ...result, additionalContext: [...(result.additionalContext ?? []), ...context] }
  })

  on('classic.PreCompact', async ($, e, next) => {
    carried = await snapshot($).catch(() => carried)
    return next(e)
  })

  on('classic.SessionEnd', async ($, e, next) => {
    await postBestEffort($, '/v1/session/end', { session_id: e.session_id }, 1)
    return next(e)
  })

  // Subagents: their type and folder when they start, and whether they run in
  // a worktree of their own (asked by the Agent call, or seen at WorktreeCreate).
  on('agent.spawn', async ($, e, next) => {
    // A top-level subagent that names no folder runs in the session's folder
    // as it is at the spawn, not as it is when the subagent later calls.
    const cwd = e.cwd ?? (e.parentAgentId === undefined ? await $.session.cwd() : undefined)
    const started = await next(e)
    if (started.agentId === undefined) return started
    // Recorded before anything else is awaited: the subagent has started.
    const agentId = started.agentId
    const isIsolated = isolatedCalls.has(e.tool_use_id) || earlyWorktrees.includes(agentId)
    isolatedCalls.delete(e.tool_use_id)
    // A teammate is named by its team name, as its checks name it.
    const teammate = started.teammateId?.split('@')[0]
    spawns[agentId] = { toolUseId: e.tool_use_id, agentType: teammate || e.subagentType }
    agentTable = addSpawn(
      agentTable,
      {
        agentId,
        subagentType: e.subagentType,
        ...(cwd === undefined ? {} : { cwd }),
        ...(e.parentAgentId === undefined ? {} : { parentAgentId: e.parentAgentId }),
        ...(e.isTeammate === true ? { isTeammate: true } : {}),
        // A teammate's settings-hook events name it by its team name
        // (`<name>` of `<name>@<team>`), not by its subagent type.
        ...(started.teammateId === undefined
          ? {}
          : { teammateName: started.teammateId.split('@')[0] ?? started.teammateId }),
      },
      isIsolated,
    )
    return started
  })

  on('classic.WorktreeCreate', async ($, e, next) => {
    // A worktree created for an isolated subagent is named `agent-<id>`: that
    // subagent will run in a folder no mod event gives. If the creation fails,
    // the subagent does not start.
    const agentId = isolatedWorktreeAgent(e)
    if (agentId !== undefined) {
      if (agentTable[agentId] !== undefined) agentTable = markUnattributable(agentTable, agentId)
      else earlyWorktrees = [...earlyWorktrees, agentId].slice(-MAX_EARLY)
    }
    return next(e)
  })

  // Each row Claude Code keeps, as stored, for the next push.
  on('session.append', async ($, e, next) => {
    const stored = await next(e)
    if (!feedSupported) return stored
    // Queued at once (no await between storing and queueing), with the folder
    // last seen for the session or the subagent's recorded one.
    const cwd = e.agentId === undefined ? knownCwd : agentTable[e.agentId]?.cwd
    feed = enqueue(feed, rowOf({ ...e, message: stored.message ?? e.message }, cwd))
    return stored
  })

  // The tool's structured result, for the history row that reports it.
  const noteResult = (id: string, result: { result?: unknown }): void => {
    if (!feedSupported) return
    // A refused or failed call has no structured result here (the transcript
    // records its error string): its row is read from the transcript.
    // A result too large or dropped is remembered by id: its row, whenever it
    // comes, is read from the transcript instead. Past that memory, a gap.
    const forgotten =
      result.result === undefined || result.result === null
        ? toolResults.unknown(id)
        : toolResults.note(id, result.result)
    if (forgotten > 0) feed = { ...feed, gap: feed.gap + forgotten }
  }

  on('tool.call', async ($, e, next) => {
    const isIsolatedAgent =
      e.tool === 'Agent' && (e as { isolation?: unknown }).isolation === 'worktree'
    if (!isIsolatedAgent && e.agentId === undefined) {
      start(e.tool_use_id)
      try {
        const result = await next(e)
        noteResult(e.tool_use_id, result)
        // The call may have moved the session (EnterWorktree, cd): the rows
        // that follow carry the folder as it is now.
        knownCwd = await $.session.cwd()
        return result
      } finally {
        stop(e.tool_use_id)
      }
    }
    if (isIsolatedAgent) isolatedCalls.add(e.tool_use_id)
    if (e.agentId !== undefined) callerOf.set(e.tool_use_id, e.agentId)
    start(e.tool_use_id)
    try {
      const result = await next(e)
      noteResult(e.tool_use_id, result)
      // A subagent that entered a worktree (created, or an existing one by its
      // path) runs from now on in a folder no mod event gives.
      const agentId = e.agentId
      const hasEntered =
        e.tool === 'EnterWorktree' && result.deny === undefined && result.isError !== true
      if (agentId !== undefined && hasEntered) agentTable = markUnattributable(agentTable, agentId)
      return result
    } finally {
      // The call is over: its spawn, if any, has been recorded.
      isolatedCalls.delete(e.tool_use_id)
      callerOf.delete(e.tool_use_id)
      stop(e.tool_use_id)
    }
  })

  // Enforcement. A failure before the daemon answered denies the call (fail
  // closed); after `next`, the result `next` settled to stands.
  on('classic.PreToolUse', async ($, e, next) => {
    const { tool, tool_use_id, ...args } = e as unknown as Record<string, unknown> & {
      tool: string
      tool_use_id: string
    }
    const info = await read($, sessionInfo)
    const caller = attribute(agentTable, callerOf.get(tool_use_id))
    let ours: PreToolUseResult
    // When the mod's own dialog asked the user, what to record for the call.
    let dialog: DialogRecord | undefined
    if (info === null) {
      ours = {
        deny:
          '[SASY] security check unavailable: sasy-guard-mod has not seen this session ' +
          'start (it was enabled mid-session); start a new session',
      }
    } else if (String(tool) === 'Agent' && args.isolation === 'remote') {
      // A remote (cloud) subagent's tool calls run where neither this mod nor
      // the local daemon sees them, so its spawn would be an unchecked channel.
      ours = {
        deny:
          '[SASY] sasy-guard-mod cannot check the tool calls of a remote (cloud) subagent; ' +
          'run the agent locally instead',
      }
    } else if (caller.kind === 'unknown') {
      ours = {
        deny:
          `[SASY] security check unavailable: this call comes from ${caller.why}, so its ` +
          'folder and identity cannot be checked; use the sasy-guard hook plugin for this workflow',
      }
    } else {
      const sessionCwd = await $.session.cwd()
      knownCwd = sessionCwd
      const cwd = caller.kind === 'agent' ? caller.cwd ?? sessionCwd : sessionCwd
      const agentType = caller.kind === 'agent' ? caller.type : info.agentType
      const input: CheckInput = {
        session_id: await $.session.id(),
        tool_name: String(tool),
        tool_input: args,
        tool_use_id,
        cwd,
        ...(info.transcriptPath === null ? {} : { transcript_path: info.transcriptPath }),
        ...(caller.kind === 'agent' ? { agent_id: caller.agentId } : {}),
        ...(agentType === null ? {} : { agent_type: agentType }),
        sasy_mod: true,
      }
      // Every check (and the re-check after an approval) first gives the daemon
      // every row kept since the last push, so it decides on the whole history.
      const check = async (checked: CheckInput): Promise<CheckAnswer> => {
        let pushed: FeedOutcome = 'unsupported'
        // All of a check's pushing, its wait for another's included, has one
        // deadline: a stalled daemon cannot hold queued calls for longer.
        const deadline = (await $.clock.now()) + PUSH_DEADLINE_MS
        // One push at a time: a check waits for one in flight, then sends what
        // is left (so two never deliver, or count, the same rows).
        while (pushInFlight !== undefined) {
          const left = deadline - (await $.clock.now())
          if (left <= 0) return { result: { deny: HISTORY_UNSENT } }
          await Promise.race([pushInFlight, $.clock.sleep(left)])
        }
        let release = (): void => {}
        pushInFlight = new Promise<void>(resolve => (release = resolve))
        try {
          // Rows kept while a push ran go out before the check too (a few
          // rounds at most); a session change while a push ran ends it.
          const generation = feedGeneration
          // A check left over from a session that has since ended (it waited
          // across /clear, /resume or /branch) must not send the new one's rows.
          if ((await $.session.id()) !== checked.session_id) pushed = 'failed'
          for (let round = 0; round < MAX_PUSH_ROUNDS && feedSupported && pushed !== 'failed'; round++) {
            if (round > 0 && (pushed !== 'sent' || (feed.rows.length === 0 && feed.gap === 0))) break
            // A row reporting a tool call still running waits, briefly, for
            // the call to finish and its structured result to be known.
            const waits = reportedCalls(feed.rows).flatMap(id => {
              const call = running.get(id)
              return call === undefined ? [] : [call.done]
            })
            const waitMs = Math.min(RESULT_WAIT_MS, deadline - (await $.clock.now()))
            if (waits.length > 0 && waitMs > 0) await Promise.race([Promise.all(waits), $.clock.sleep(waitMs)])
            if (generation !== feedGeneration) {
              pushed = 'failed' // the session changed while this check waited
              break
            }
            const pending = { ...feed, rows: [...feed.rows] }
            const base = {
              session_id: checked.session_id,
              cwd: sessionCwd,
              ...(info.transcriptPath === null ? {} : { transcript_path: info.transcriptPath }),
            }
            // A row the mod cannot give whole goes marked: the daemon takes it
            // from the transcript (waiting until it is written).
            const sending = withResults(pending.rows, toolResults, id => running.has(id))
            const gap = pending.gap > 0
            let { outcome, sent } = await sendFeed($, base, sending, spawns, gap, deadline)
            if (outcome === 'unreachable' && deadline - (await $.clock.now()) > ENSURE_TIMEOUT_MS + 1000) {
              // As for a check: start the daemon once and send everything again
              // (a new daemon may hold none of it; it skips rows it has).
              await ensureDaemon($)
              ;({ outcome, sent } = await sendFeed($, base, sending, spawns, gap, deadline))
            }
            pushed = outcome
            if (generation !== feedGeneration) break // another session's buffer now
            if (outcome === 'unsupported') {
              feedSupported = false
              feed = emptyBuffer()
              toolResults.clear()
            } else {
              feed = afterPush(feed, pending, sent, sent > 0 || outcome === 'sent')
              // The results those rows carried are delivered: no longer needed.
              toolResults.forget(reportedCalls(sending.slice(0, sent)))
            }
          }
        } finally {
          pushInFlight = undefined
          release()
        }
        // Undelivered history is never checked around: the daemon would decide
        // without it (also rows still arriving after the last round). Only an
        // unreachable daemon may fail open, as for a check.
        if (pushed === 'sent' && feedSupported && (feed.rows.length > 0 || feed.gap > 0)) pushed = 'failed'
        if (pushed === 'sent' || pushed === 'unsupported') return checkCall($, checked)
        if (pushed === 'unreachable' && (await failsOpen($))) return { result: {} }
        return { result: { deny: HISTORY_UNSENT } }
      }
      const answer = await check(input)
      // A one-time bypass on offer: ask the user here, holding the call, where
      // someone can be asked; elsewhere the denial (with its model-driven
      // AskUserQuestion instructions) stands, as with the hook plugin.
      if (answer.offer !== undefined && (await canAsk($))) {
        const outcome = await askForBypass($, input, answer.offer, check)
        ours = outcome.result
        dialog = outcome.record
      } else {
        ours = answer.result
      }
    }
    // Any other settings hooks run whatever SASY answered.
    const theirs = await next(e)
    const result = ours.deny !== undefined ? denyWith(ours, theirs) : combine(ours, theirs)
    // What SASY decided, not what another hook made of the call.
    await recordSafely($, e, ours, dialog)
    return result
  }).catch(() =>
    // Any failure denies, also after `next`: the engine refusing this mod's
    // answer (an input rewrite its tool does not accept) must not let the
    // call run as the other hooks left it.
    ({ deny: '[SASY] security check failed inside sasy-guard-mod' }),
  )

  on('command.run', { command: COMMAND }, async ($, e, next) => {
    if (!ownsCommand) return next(e)
    return { text: guardText(await daemonHealth($), await read($, counts), await read($, decisions)) }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const latest = (await read($, decisions)).at(-1)
    if (e.props.hasSurvey || latest === undefined) return next(e)
    if (latest.seq <= (await read($, dismissedSeq))) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const { verb, color, shown } = bandLines(latest, e.props.maxRows)

    // Later mods share the band: keep what they draw below ours.
    const theirs = await next(e)
    return (
      <Box flexDirection="column">
        <Text color={color} bold>
          sasy-guard {verb} {latest.tool}
          {latest.target === '' ? '' : `: ${latest.target}`}
        </Text>
        {shown.map(line => (
          <Text dimColor>{line}</Text>
        ))}
        <Box>
          <Button
            key="dismiss"
            label="Dismiss"
            onPress={() => update($, dismissedSeq, () => latest.seq)}
          />
        </Box>
        {theirs}
      </Box>
    )
  })
}
