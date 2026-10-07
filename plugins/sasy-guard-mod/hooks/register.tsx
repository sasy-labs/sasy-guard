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

import type { GuardCounts, GuardDecision, GuardSessionInfo, GuardVerdict } from '../types'
import type { AgentTable } from './agents'
import type { Carried } from './carry'
import { WORKTREE_WHY, addSpawn, attribute, markUnattributable, isolatedWorktreeAgent } from './agents'
import { MAX_EARLY, carryOver } from './carry'
import type { BypassOffer, CheckAnswer, CheckInput } from './enforce'
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
const MAX_DECISIONS = 50
const RECENT_IN_COMMAND = 5
/** The band shows the policy's reason and fix; /guard has the rest. */
const BAND_REASON_LINES = 3
const TARGET_CHARS = 80
const HEALTH_TIMEOUT_MS = 3000
const MARKER = '[SASY]'
const REASON_CHARS = 4000

const counts = atom({ plugin: 'sasy-guard-mod', key: 'counts' } as const, {
  checked: 0,
  denied: 0,
  asked: 0,
})
const decisions = atom({ plugin: 'sasy-guard-mod', key: 'decisions' } as const, [])
const dismissedSeq = atom({ plugin: 'sasy-guard-mod', key: 'dismissedSeq' } as const, 0)
const sessionInfo = atom(
  { plugin: 'sasy-guard-mod', key: 'sessionInfo' } as const,
  null as GuardSessionInfo | null,
)
const agents = atom({ plugin: 'sasy-guard-mod', key: 'agents' } as const, {} as AgentTable)
/** Agent ids whose worktree appeared before their spawn finished. */
const isolatedEarly = atom({ plugin: 'sasy-guard-mod', key: 'isolatedEarly' } as const, [] as string[])

/** What the model is told at SessionStart, as the hook plugin's script says it. */
const SESSION_NOTE =
  'SASY policy enforcement is active for this session. Tool calls are checked against ' +
  'a security policy; denied calls return a [SASY] reason — relay it to the user and ' +
  'follow its suggested fix rather than retrying or working around it.'

/** The tool-call fields that name what a call acts on, in order of preference. */
const TARGET_FIELDS = ['command', 'file_path', 'notebook_path', 'url', 'path', 'pattern']

/** C0 and C1 control characters other than newline and tab, and the
 *  invisible or reordering marks (soft hyphen, zero-width, bidirectional,
 *  variation selectors, tags) that could make a drawn command or path look
 *  like a different one. */
const CONTROL =
  /[\u0000-\u0008\u000b-\u001f\u007f\u0080-\u009f\u00ad\u061c\u180e\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufe00-\ufe0f\ufeff\u{e0000}-\u{e007f}\u{e0100}-\u{e01ef}]/gu

function shorten(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').replace(CONTROL, '').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}

function targetOf(e: Readonly<Record<string, unknown>>): string {
  for (const field of TARGET_FIELDS) {
    const value = e[field]
    if (typeof value === 'string' && value !== '') return shorten(value, TARGET_CHARS)
  }
  return ''
}

/**
 * A policy reason as the band and /guard show it: control characters other
 * than newline and tab removed, and held to REASON_CHARS. The model has already
 * read the same text as the call's result; this keeps the session's own copy
 * small and free of terminal escapes.
 */
function cleanReason(text: string): string {
  const clean = text.replace(CONTROL, '').trim()
  return clean.length <= REASON_CHARS ? clean : `${clean.slice(0, REASON_CHARS - 1)}…`
}

/** The sasy-guard verdict in a PreToolUse result, or none for any other. */
function verdictOf(result: PreToolUseResult): { verdict: GuardVerdict; reason: string } | null {
  const pairs: [GuardVerdict, string | undefined][] = [
    ['deny', result.deny],
    ['ask', result.ask],
  ]
  for (const [verdict, text] of pairs) {
    // The engine may wrap the hook's text (`PreToolUse:Bash hook error: ...`);
    // the policy's own words start at the marker.
    const at = text?.indexOf(MARKER) ?? -1
    if (text !== undefined && at >= 0) {
      return { verdict, reason: cleanReason(text.slice(at + MARKER.length)) }
    }
  }
  return null
}

function statusText(c: GuardCounts): string {
  return `${c.checked} checked · ${c.denied} denied · ${c.asked} asked`
}

function clockTime(ms: number): string {
  return new Date(ms).toTimeString().slice(0, 8)
}

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
  if (
    isDown &&
    port !== undefined &&
    (await $.env.get('SASY_FAIL_OPEN')) === 'true' &&
    (await authHeaderFile($, port)) !== undefined
  ) {
    return { result: {} }
  }
  const why = 'error' in answer ? answer.error : 'sasy-watch gave an answer that is not a decision'
  return { result: { deny: `[SASY] security check unavailable (${why})` } }
}

/** What the dialog's buttons say, by the daemon's canonical choice. */
function choiceLabels(offer: BypassOffer): Record<string, string> {
  return {
    approve: 'Approve once',
    decline: 'Deny',
    ...(offer.domain === undefined ? {} : { 'trust-domain': `Trust ${offer.domain} for this session` }),
  }
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
  attemptsLeft = 1,
): Promise<DialogOutcome> {
  return askAbout($, input, cleanOffer(offer), attemptsLeft)
}

/** The offer's daemon-authored texts as the mod draws every reason. */
function cleanOffer(offer: BypassOffer): BypassOffer {
  return {
    ...offer,
    question: cleanReason(offer.question),
    reason: cleanReason(offer.reason),
    policyReason: cleanReason(offer.policyReason),
  }
}

async function askAbout(
  $: EngineInterface,
  input: CheckInput,
  offer: BypassOffer,
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
    return {
      result: { deny: `[SASY] The approval could not be recorded, so the action stays blocked.\n\n${policy}` },
      record: { verdict: 'declined', reason: `${offer.reason} — your approval could not be recorded` },
    }
  }
  const again = await checkCall($, input)
  if (again.result.deny !== undefined) {
    // The decision's grounds changed since the question: ask about the new one.
    if (again.offer !== undefined && attemptsLeft > 0) {
      return askForBypass($, input, again.offer, attemptsLeft - 1)
    }
    if (again.offer !== undefined) {
      // It changed again: stop asking, keep the call blocked, and say why.
      const changed = cleanOffer(again.offer)
      const fix = changed.policyReason.replace(MARKER, '').trim()
      return {
        result: {
          deny:
            '[SASY] The decision changed again after the user approved it, so the action ' +
            `stays blocked.\n\n${fix}`,
        },
        record: { verdict: 'declined', reason: `${changed.reason} — changed again after your approval` },
      }
    }
    // A plain denial now (new evidence): recorded as the denial it is.
    return { result: again.result }
  }
  const note =
    choice === 'trust-domain'
      ? `The user chose in the SASY dialog to trust ${offer.domain ?? 'this host'} for the rest ` +
        'of this session; this action may proceed.'
      : 'The user approved a one-time bypass of a SASY check for this action in the SASY dialog.'
  return {
    result: { ...again.result, additionalContext: [...(again.result.additionalContext ?? []), note] },
    record: {
      verdict: 'approved',
      reason:
        choice === 'trust-domain'
          ? `${offer.reason} — you trusted ${offer.domain ?? 'the host'} for this session`
          : `${offer.reason} — you approved it once`,
    },
  }
}

/** The /healthz fields /guard prints, each held to the shape the daemon sends. */
/** An endpoint /guard may print: a DNS host name, an IPv4 address or a
 *  bracketed IPv6 address, and a port. Anything else is not printed. */
const ENDPOINT =
  /^(?=.{1,259}$)([A-Za-z0-9-]{1,63}(\.[A-Za-z0-9-]{1,63})*|\[[0-9a-fA-F:]{2,39}\]):\d{1,5}$/
const FAIL_MODES = ['open', 'closed']

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

/** One decision for /guard: a heading, then its reason, whole or first line. */
function decisionLines(d: GuardDecision, isWhole: boolean): string[] {
  const head = `  ${clockTime(d.at)}  ${d.verdict.padEnd(8)}  ${d.tool}  ${d.target}`
  const reason = d.reason.split('\n').filter(line => line.trim() !== '')
  const body = isWhole ? reason : reason.slice(0, 1).map(line => shorten(line, 120))
  return [head.trimEnd(), ...body.map(line => `            ${line}`)]
}

/** What the mod's own dialog came to, for the record: the offer the user
 *  answered (its reason) and whether they approved. */
type DialogRecord = { verdict: 'approved' | 'declined'; reason: string }

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
 * the call to the .catch handler, which replays only the downstream result and
 * would lose this mod's own decision.
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

/** The values a reset would clear, read just before it. */
async function snapshot($: EngineInterface): Promise<Carried> {
  return {
    agents: await read($, agents),
    isolatedEarly: await read($, isolatedEarly),
    counts: await read($, counts),
    decisions: await read($, decisions),
    dismissedSeq: await read($, dismissedSeq),
  }
}

/** Puts back what a reset cleared (carry.ts says what comes back). */
async function restore($: EngineInterface, kept: Carried, source: unknown): Promise<void> {
  const next = carryOver(kept, await snapshot($), source)
  await update($, agents, () => next.agents)
  await update($, isolatedEarly, () => next.isolatedEarly)
  await update($, counts, () => next.counts)
  await update($, decisions, () => next.decisions)
  await update($, dismissedSeq, () => next.dismissedSeq)
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
  // Subagents now in a worktree, held here too so a failed state write cannot
  // leave one attributed to its old folder.
  const inWorktree = new Set<string>()
  // $.state as it stood before the last compaction or session end, put back
  // by classic.SessionStart.
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
  // clear $.state without a new session.start: put back what was carried,
  // re-pin the status line and keep what each check needs to say about the
  // session.
  on('classic.SessionStart', async ($, e, next) => {
    if (carried !== undefined) {
      try {
        await restore($, carried, e.source)
      } catch {
        // A subagent left unrecorded is denied, as one started before the mod.
      }
      carried = undefined
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
    carried = await snapshot($).catch(() => carried)
    await postBestEffort($, '/v1/session/end', { session_id: e.session_id }, 1)
    return next(e)
  })

  // Subagents: their type and folder when they start, and whether they run in
  // a worktree of their own (asked by the Agent call, or seen at WorktreeCreate).
  on('agent.spawn', async ($, e, next) => {
    const started = await next(e)
    if (started.agentId === undefined) return started
    const agentId = started.agentId
    // A top-level subagent that names no folder runs in the session's folder
    // as it was at the spawn, not as it is when the subagent later calls.
    const cwd = e.cwd ?? (e.parentAgentId === undefined ? await $.session.cwd() : undefined)
    const early = await read($, isolatedEarly)
    const isIsolated = isolatedCalls.has(e.tool_use_id) || early.includes(agentId)
    isolatedCalls.delete(e.tool_use_id)
    await update($, agents, table =>
      addSpawn(
        table,
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
      ),
    )
    return started
  })

  on('classic.WorktreeCreate', async ($, e, next) => {
    // A worktree created for an isolated subagent is named `agent-<id>`: that
    // subagent will run in a folder no mod event gives. If the creation fails,
    // the subagent does not start.
    const agentId = isolatedWorktreeAgent(e)
    if (agentId !== undefined) {
      inWorktree.add(agentId)
      const known = (await read($, agents))[agentId] !== undefined
      if (known) await update($, agents, table => markUnattributable(table, agentId))
      else await update($, isolatedEarly, ids => [...ids, agentId].slice(-MAX_EARLY))
    }
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const isIsolatedAgent =
      e.tool === 'Agent' && (e as { isolation?: unknown }).isolation === 'worktree'
    if (!isIsolatedAgent && e.agentId === undefined) return next(e)
    if (isIsolatedAgent) isolatedCalls.add(e.tool_use_id)
    if (e.agentId !== undefined) callerOf.set(e.tool_use_id, e.agentId)
    try {
      const result = await next(e)
      // A subagent that entered a worktree (created, or an existing one by its
      // path) runs from now on in a folder no mod event gives.
      const agentId = e.agentId
      const hasEntered =
        e.tool === 'EnterWorktree' && result.deny === undefined && result.isError !== true
      if (agentId !== undefined && hasEntered) {
        inWorktree.add(agentId)
        try {
          await update($, agents, table => markUnattributable(table, agentId))
        } catch {
          // inWorktree still denies its calls.
        }
      }
      return result
    } finally {
      // The call is over: its spawn, if any, has been recorded.
      isolatedCalls.delete(e.tool_use_id)
      callerOf.delete(e.tool_use_id)
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
    const callerId = callerOf.get(tool_use_id)
    const caller =
      callerId !== undefined && inWorktree.has(callerId)
        ? { kind: 'unknown' as const, why: WORKTREE_WHY }
        : attribute(await read($, agents), callerId)
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
      const answer = await checkCall($, input)
      // A one-time bypass on offer: ask the user here, holding the call, where
      // someone can be asked; elsewhere the denial (with its model-driven
      // AskUserQuestion instructions) stands, as with the hook plugin.
      if (answer.offer !== undefined && (await canAsk($))) {
        const outcome = await askForBypass($, input, answer.offer)
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
  }).catch(($, e, next) =>
    next.called ? next(e) : { deny: '[SASY] security check failed inside sasy-guard-mod' },
  )

  on('command.run', { command: COMMAND }, async ($, e, next) => {
    if (!ownsCommand) return next(e)
    const c = await read($, counts)
    const recent = (await read($, decisions)).slice(-RECENT_IN_COMMAND).reverse()
    const lines = [
      await daemonHealth($),
      `this session: ${c.checked} checked · ${c.denied} denied · ${c.asked} asked`,
    ]
    if (recent.length === 0) {
      lines.push('no denials or approval requests yet')
    } else {
      lines.push(
        'recent decisions (newest first):',
        ...recent.flatMap((d, i) => decisionLines(d, i === 0)),
      )
    }
    return { text: lines.join('\n') }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const latest = (await read($, decisions)).at(-1)
    if (e.props.hasSurvey || latest === undefined) return next(e)
    if (latest.seq <= (await read($, dismissedSeq))) return next(e)

    const { Box, Button, Text } = $.ui.resolve(e)
    const verb = {
      deny: 'denied',
      ask: 'needs approval for',
      approved: 'asked you, and you allowed',
      declined: 'asked you, and blocked',
    }[latest.verdict]
    const color = { deny: 'red', ask: 'yellow', approved: 'green', declined: 'red' }[latest.verdict]
    // Rows besides the reason: the heading, a possible overflow line, the button.
    const room = Math.max(1, Math.min(BAND_REASON_LINES, e.props.maxRows - 3))
    const reason = latest.reason.split('\n').filter(line => line.trim() !== '')
    const shown = reason.slice(0, room)
    if (reason.length > room) shown.push('… full text: /guard')

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
