// sasy-guard mod: shows the decisions the plugin's PreToolUse hook makes.
//
// Observe only. Enforcement stays in the settings hooks beside this module
// (hooks.json `hooks`); this module reads each verdict they return through
// `classic.PreToolUse` and draws it: a status line with the session's counts,
// a band above the prompt for the latest denial or approval request, and a
// `/guard` command that answers at once, with no model turn.
import { atom, read, update } from 'claude-code'
import type { EngineInterface, PreToolUseResult, Register } from 'claude-code'

import type { GuardCounts, GuardDecision, GuardVerdict } from '../types'

const PLUGIN = 'sasy-guard'
const COMMAND = 'guard'
const MAX_DECISIONS = 50
const RECENT_IN_COMMAND = 5
/** The band shows the policy's reason and fix; /guard has the rest. */
const BAND_REASON_LINES = 3
const TARGET_CHARS = 80
const HEALTH_TIMEOUT_MS = 1500
const DEFAULT_PORT = '51711'
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

/** One line on the sasy-watch daemon, from its /healthz route. */
async function daemonHealth($: EngineInterface): Promise<string> {
  const port = (await $.env.get('SASY_WATCH_PORT')) || DEFAULT_PORT
  const url = `http://127.0.0.1:${port}/healthz`
  const timeout = $.clock.sleep(HEALTH_TIMEOUT_MS).then(() => null)
  try {
    const response = await Promise.race([$.http.fetch(url), timeout])
    if (response === null) return `daemon: no answer from ${url} within ${HEALTH_TIMEOUT_MS} ms`
    if (!response.ok) return `daemon: ${url} answered HTTP ${response.status}`
    const h = JSON.parse(response.text) as Record<string, unknown>
    const state = h.ready === true ? 'up, policy engine ready' : 'up, policy engine not ready'
    return (
      `daemon: ${state} · endpoint ${String(h.endpoint)} · ` +
      `fail mode ${String(h.failMode)} · ${String(h.sessions)} session(s)`
    )
  } catch (error) {
    const why = error instanceof Error ? error.message : String(error)
    return `daemon: unreachable at ${url} (${shorten(why, 120)})`
  }
}

/** One decision for /guard: a heading, then its reason, whole or first line. */
function decisionLines(d: GuardDecision, isWhole: boolean): string[] {
  const head = `  ${clockTime(d.at)}  ${d.verdict.padEnd(4)}  ${d.tool}  ${d.target}`
  const reason = d.reason.split('\n').filter(line => line.trim() !== '')
  const body = isWhole ? reason : reason.slice(0, 1).map(line => shorten(line, 120))
  return [head.trimEnd(), ...body.map(line => `            ${line}`)]
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: 'Show sasy-guard daemon health and recent policy decisions',
    })
    $.ui.status(statusText(await read($, counts)))
    return next(e)
  })

  on('classic.PreToolUse', async ($, e, next) => {
    const result = await next(e)
    const found = verdictOf(result)
    const total = await update($, counts, c => ({
      checked: c.checked + 1,
      denied: c.denied + (found?.verdict === 'deny' ? 1 : 0),
      asked: c.asked + (found?.verdict === 'ask' ? 1 : 0),
    }))
    $.ui.status(statusText(total))
    if (found !== null) {
      const at = await $.clock.now()
      await update($, decisions, list => {
        const seq = (list[list.length - 1]?.seq ?? 0) + 1
        const decision: GuardDecision = {
          seq,
          at,
          tool: String(e.tool),
          target: targetOf(e as Readonly<Record<string, unknown>>),
          ...found,
        }
        return [...list, decision].slice(-MAX_DECISIONS)
      })
    }
    return result
  }).catch(($, e, next) => next(e))

  on('command.run', { command: COMMAND }, async $ => {
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
      </Box>
    )
  })
}
