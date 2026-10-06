// sasy-guard mod: checks each tool call against the policy and shows the result.
//
// At `classic.PreToolUse`, which runs just above the settings hooks, the mod
// asks the sasy-watch daemon about the call (enforce.ts) and refuses it, asks
// the user, or lets it go on to the other settings hooks. Each call it checked
// is listed in SASY_GUARD_MOD_CHECKED, and the plugin's own PreToolUse script
// stands aside for exactly those calls, so a call is checked once. Where the
// mod does not load, the script checks every call as before.
//
// It also draws the decisions: a status line with the session's counts, a band
// above the prompt for the latest denial or approval request, and a `/guard`
// command that answers at once, with no model turn.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, PreToolUseResult, Register } from 'claude-code'

import type { GuardCounts, GuardDecision, GuardVerdict } from '../types'
import type { CheckInput } from './enforce'
import {
  CHECK_TIMEOUT_MS,
  DEFAULT_PORT,
  ENSURE_TIMEOUT_MS,
  checkArgv,
  combine,
  splitStatus,
  toResult,
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

const counts = atom({ plugin: 'sasy-guard', key: 'counts' } as const, {
  checked: 0,
  denied: 0,
  asked: 0,
})
const decisions = atom({ plugin: 'sasy-guard', key: 'decisions' } as const, [])
const dismissedSeq = atom({ plugin: 'sasy-guard', key: 'dismissedSeq' } as const, 0)

/** The tool-call fields that name what a call acts on, in order of preference. */
const TARGET_FIELDS = ['command', 'file_path', 'notebook_path', 'url', 'path', 'pattern']

function shorten(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}

function targetOf(e: Readonly<Record<string, unknown>>): string {
  for (const field of TARGET_FIELDS) {
    const value = e[field]
    if (typeof value === 'string' && value !== '') return shorten(value, TARGET_CHARS)
  }
  return ''
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
      return { verdict, reason: text.slice(at + MARKER.length).trim() }
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

/** One POST to /v1/pretooluse; the answer's body, or why there is none. */
async function postCheck(
  $: EngineInterface,
  port: string,
  input: CheckInput,
): Promise<{ body: string } | { error: string }> {
  const argv = checkArgv(port, await authHeaderFile($, port))
  let ran: { exitCode: number; stdout: string }
  try {
    ran = await $.process.run(argv, { stdin: JSON.stringify(input), timeoutMs: CHECK_TIMEOUT_MS })
  } catch {
    return { error: 'could not run curl' }
  }
  if (ran.exitCode !== 0) return { error: `sasy-watch unreachable on port ${port}` }
  const { body, status } = splitStatus(ran.stdout)
  return status === '200' ? { body } : { error: `sasy-watch answered HTTP ${status}` }
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
async function checkCall($: EngineInterface, input: CheckInput): Promise<PreToolUseResult> {
  const port = await daemonPort($)
  let answer: { body: string } | { error: string } =
    port === undefined ? { error: 'SASY_WATCH_PORT is not a port number' } : await postCheck($, port, input)
  if ('error' in answer && port !== undefined) {
    await ensureDaemon($)
    answer = await postCheck($, port, input)
  }
  const result = 'body' in answer ? toResult(answer.body) : undefined
  if (result !== undefined) return result
  if ((await $.env.get('SASY_FAIL_OPEN')) === 'true') return {}
  const why = 'error' in answer ? answer.error : 'sasy-watch gave an answer that is not a decision'
  return { deny: `[SASY] security check unavailable (${why})` }
}

/** The /healthz fields /guard prints, each held to the shape the daemon sends. */
const ENDPOINT = /^[A-Za-z0-9.:[\]_-]{1,255}$/
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
  const head = `  ${clockTime(d.at)}  ${d.verdict.padEnd(4)}  ${d.tool}  ${d.target}`
  const reason = d.reason.split('\n').filter(line => line.trim() !== '')
  const body = isWhole ? reason : reason.slice(0, 1).map(line => shorten(line, 120))
  return [head.trimEnd(), ...body.map(line => `            ${line}`)]
}

/** Counts one checked call and keeps it when it carries a [SASY] verdict. */
async function record(
  $: EngineInterface,
  e: Readonly<Record<string, unknown>>,
  result: PreToolUseResult,
): Promise<void> {
  const found = verdictOf(result)
  const total = await update($, counts, c => ({
    checked: c.checked + 1,
    denied: c.denied + (found?.verdict === 'deny' ? 1 : 0),
    asked: c.asked + (found?.verdict === 'ask' ? 1 : 0),
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
 * Lists the calls this mod is checking in SASY_GUARD_MOD_CHECKED, which the
 * settings hooks Claude Code starts next inherit; pretooluse.sh stands aside
 * for exactly those tool_use_ids.
 */
async function publishChecking($: EngineInterface, ids: ReadonlySet<string>): Promise<void> {
  await $.env.set('SASY_GUARD_MOD_CHECKED', ids.size === 0 ? undefined : [...ids].join(' '))
}

export const register: Register = on => {
  // Hooks that only observe carry no .catch: one that fails before next is
  // skipped, and one that fails after next leaves next's result standing.
  // Whether /guard registered; if another plugin owns the name, pass it on.
  let ownsCommand = false
  // The subagent behind each call in flight, by tool_use_id (tool.call has it,
  // classic.PreToolUse does not), and the calls this mod is checking now.
  const agentOf = new Map<string, string>()
  const checking = new Set<string>()

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

  // /clear, /resume and /branch reset $.state without a new session.start.
  on('classic.SessionStart', { source: ['clear', 'resume', 'fork'] }, async ($, e, next) => {
    $.ui.status(statusText(await read($, counts)))
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    if (e.agentId === undefined) return next(e)
    agentOf.set(e.tool_use_id, e.agentId)
    try {
      return await next(e)
    } finally {
      agentOf.delete(e.tool_use_id)
    }
  })

  // Enforcement. A failure before the daemon answered denies the call (fail
  // closed); after `next`, the result `next` settled to stands.
  on('classic.PreToolUse', async ($, e, next) => {
    const { tool, tool_use_id, ...args } = e as unknown as Record<string, unknown> & {
      tool: string
      tool_use_id: string
    }
    const agentId = agentOf.get(tool_use_id)
    let agentType: string | undefined
    if (agentId !== undefined) {
      agentType = (await $.agent.list()).find(a => a.id === agentId)?.type
    }
    const ours = await checkCall($, {
      session_id: await $.session.id(),
      tool_name: String(tool),
      tool_input: args,
      tool_use_id,
      cwd: await $.session.cwd(),
      ...(agentId === undefined ? {} : { agent_id: agentId }),
      ...(agentType === undefined ? {} : { agent_type: agentType }),
    })
    let result: PreToolUseResult
    if (ours.deny !== undefined) {
      // Refused: the other settings hooks need not run, as when the script denies.
      result = ours
    } else {
      checking.add(tool_use_id)
      await publishChecking($, checking)
      try {
        result = combine(ours, await next(e))
      } finally {
        checking.delete(tool_use_id)
        await publishChecking($, checking)
      }
    }
    await record($, e as unknown as Readonly<Record<string, unknown>>, result)
    return result
  }).catch(($, e, next) =>
    next.called ? next(e) : { deny: '[SASY] security check failed inside the sasy-guard mod' },
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
    const verb = latest.verdict === 'deny' ? 'denied' : 'needs approval for'
    const color = latest.verdict === 'deny' ? 'red' : 'yellow'
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
