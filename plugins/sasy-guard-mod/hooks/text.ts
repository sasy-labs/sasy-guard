// Pure text helpers: what the mod draws, prints and records, held to the
// shapes the daemon sends and stripped of what could disguise it. Split from
// the hooks module, which keeps everything that talks to Claude Code.
import type { PreToolUseResult } from 'claude-code'

import type { GuardCounts, GuardDecision, GuardVerdict } from '../types'
import type { BypassOffer } from './enforce'

/** The most characters of a call's target the band and /guard show. */
export const TARGET_CHARS = 80
/** Where the policy's own words start in a hook's text. */
export const MARKER = '[SASY]'
const REASON_CHARS = 4000

/** What the model is told at SessionStart, as the hook plugin's script says it. */
export const SESSION_NOTE =
  'SASY policy enforcement is active for this session. Tool calls are checked against ' +
  'a security policy; denied calls return a [SASY] reason — relay it to the user and ' +
  'follow its suggested fix rather than retrying or working around it.'

/** The tool-call fields that name what a call acts on, in order of preference. */
export const TARGET_FIELDS = ['command', 'file_path', 'notebook_path', 'url', 'path', 'pattern']

/** Control and format characters (C0 and C1 controls other than newline and
 *  tab, bidirectional marks, tags), every default-ignorable code point (zero-
 *  width characters, variation selectors, fillers that draw as nothing), and
 *  the blank Braille pattern: whatever could make a drawn command or path look
 *  like a different one or hide it. */
export const CONTROL =
  /(?![\n\t])[\p{Cc}\p{Cf}\p{Default_Ignorable_Code_Point}\u2800]/gu

export function shorten(text: string, max: number): string {
  const flat = text.replace(/\s+/g, ' ').replace(CONTROL, '').trim()
  return flat.length <= max ? flat : `${flat.slice(0, max - 1)}…`
}

export function targetOf(e: Readonly<Record<string, unknown>>): string {
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
export function cleanReason(text: string): string {
  const clean = text.replace(CONTROL, '').trim()
  return clean.length <= REASON_CHARS ? clean : `${clean.slice(0, REASON_CHARS - 1)}…`
}

/** The sasy-guard verdict in a PreToolUse result, or none for any other. */
export function verdictOf(result: PreToolUseResult): { verdict: GuardVerdict; reason: string } | null {
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

export function statusText(c: GuardCounts): string {
  return `${c.checked} checked · ${c.denied} denied · ${c.asked} asked`
}

export function clockTime(ms: number): string {
  return new Date(ms).toTimeString().slice(0, 8)
}

/** What the dialog's buttons say, by the daemon's canonical choice. */
export function choiceLabels(offer: BypassOffer): Record<string, string> {
  return {
    approve: 'Approve once',
    decline: 'Deny',
    ...(offer.domain === undefined ? {} : { 'trust-domain': `Trust ${offer.domain} for this session` }),
  }
}

/**
 * Text that must keep its end: the question ends with what is being approved
 * (`Attempted: ...`) and the policy reason with its fix. Control characters
 * are removed as for every reason; past REASON_CHARS the middle goes.
 */
function cleanKeepingEnd(text: string): string {
  const clean = text.replace(CONTROL, '').trim()
  if (clean.length <= REASON_CHARS) return clean
  const tail = Math.floor(REASON_CHARS * 0.6)
  return `${clean.slice(0, REASON_CHARS - tail - 3)} … ${clean.slice(-tail)}`
}

/** The offer's daemon-authored texts as the mod draws every reason. */
export function cleanOffer(offer: BypassOffer): BypassOffer {
  return {
    ...offer,
    question: cleanKeepingEnd(offer.question),
    reason: cleanReason(offer.reason),
    policyReason: cleanKeepingEnd(offer.policyReason),
  }
}

/** The /healthz fields /guard prints, each held to the shape the daemon sends. */
/** An endpoint /guard may print: a DNS host name, an IPv4 address or a
 *  bracketed IPv6 address, and a port. Anything else is not printed. */
export const ENDPOINT =
  /^(?=.{1,259}$)([A-Za-z0-9-]{1,63}(\.[A-Za-z0-9-]{1,63})*|\[[0-9a-fA-F:]{2,39}\]):\d{1,5}$/
export const FAIL_MODES = ['open', 'closed']

/** One decision for /guard: a heading, then its reason, whole or first line. */
export function decisionLines(d: GuardDecision, isWhole: boolean): string[] {
  const head = `  ${clockTime(d.at)}  ${d.verdict.padEnd(8)}  ${d.tool}  ${d.target}`
  const reason = d.reason.split('\n').filter(line => line.trim() !== '')
  const body = isWhole ? reason : reason.slice(0, 1).map(line => shorten(line, 120))
  return [head.trimEnd(), ...body.map(line => `            ${line}`)]
}
