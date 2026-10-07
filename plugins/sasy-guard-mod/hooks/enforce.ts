// The daemon requests' pure parts: the curl arguments for the sasy-watch
// daemon's routes (the settings hooks' own payloads), and how the daemon's
// answer to a policy check becomes a `classic.PreToolUse` result. register.tsx
// makes the calls, since only it may hold the engine interface.
import type { PreToolUseResult } from 'claude-code'

export const DEFAULT_PORT = '51711'
export const CHECK_TIMEOUT_MS = 12_000
export const ENSURE_TIMEOUT_MS = 10_000

/** What the daemon is asked about one tool call: the settings hook's stdin. */
export type CheckInput = {
  session_id: string
  tool_name: string
  tool_input: Record<string, unknown>
  tool_use_id: string
  cwd: string
  transcript_path?: string
  /** A subagent's id, as the hook receives it for a subagent's call. */
  agent_id?: string
  /** The caller's agent type: a subagent's, or a session started with --agent. */
  agent_type?: string
  /** The session's permission mode (`default`, `acceptEdits`, `plan`, ...), as
   *  of the latest prompt or finished tool call; the hook receives it the same
   *  way. Left out until the mod has seen it. */
  permission_mode?: string
  /** Marks the mod, so a daemon that supports it adds the bypass offer for the
   *  mod's own dialog (`sasyApproval`); an older daemon ignores it. */
  sasy_mod: true
}

/** What the daemon is told about the host, as the hook plugin's scripts tell
 *  it: Claude Code's entrypoint (`cli`, `claude-vscode`, ...) and the terminal
 *  program. The daemon logs both and uses the entrypoint to detect the host. */
export type HostHeaders = { entrypoint: string; term: string }

/** A value safe in a header line: no control characters, at most 64
 *  characters (the scripts' `header_safe`). */
export function headerSafe(value: string | undefined): string {
  return (value ?? '').replace(/[\u0000-\u001f\u007f]/g, '').slice(0, 64)
}

/** A one-time bypass the daemon offers on a denial, for the mod's own dialog. */
export type BypassOffer = {
  /** The daemon-authored question, ending in its `[SASY-ALLOW:…]` routing tag. */
  question: string
  /** The canonical choices: approve, decline, and trust-domain when offered. */
  labels: string[]
  /** The policy's reason as the user should read it. */
  reason: string
  /** The policy's reason with its suggested fix, as the model should read it. */
  policyReason: string
  /** The domain trust-domain would trust for the session, when offered. */
  domain?: string
}

/** A check's answer: the decision, and the bypass the daemon offers with it. */
export type CheckAnswer = { result: PreToolUseResult; offer?: BypassOffer }

/** The daemon's two choice lists: without and with a host to trust. */
const PLAIN_LABELS = ['approve', 'decline']
const TRUST_LABELS = ['approve', 'decline', 'trust-domain']
/** Whether `labels` is exactly `expected`, element by element. */
const isExactly = (labels: unknown[], expected: string[]): boolean =>
  labels.length === expected.length && labels.every((label, i) => label === expected[i])
/** A host the daemon names for session trust, as it derives one: 3 to 253
 *  characters of [a-z0-9.-], with at least one dot between labels. */
const DOMAIN = /^(?=.{3,253}$)[a-z0-9-]+(\.[a-z0-9-]+)+$/

/** The `sasyApproval` field of a daemon answer, or undefined when it is not one. */
function offerOf(value: unknown): BypassOffer | undefined {
  if (!isRecord(value)) return undefined
  const { question, labels, reason, policyReason, domain, ...unknown } = value
  const isValid =
    Object.keys(unknown).length === 0 &&
    typeof question === 'string' && question !== '' &&
    typeof reason === 'string' &&
    typeof policyReason === 'string' &&
    Array.isArray(labels) &&
    (domain === undefined
      ? isExactly(labels, PLAIN_LABELS)
      : typeof domain === 'string' && DOMAIN.test(domain) && isExactly(labels, TRUST_LABELS))
  if (!isValid) return undefined
  return {
    question: question as string,
    labels: labels as string[],
    reason: reason as string,
    policyReason: policyReason as string,
    ...(domain === undefined ? {} : { domain: domain as string }),
  }
}

/**
 * curl's arguments for one POST to the daemon: bounded in time and size, never
 * via a proxy, the body on stdin, the HTTP status appended on a line of its
 * own. A daemon that authenticates hooks is sent its header file with
 * `-H @file`, so the secret never appears in a process's arguments.
 */
export function postArgv(
  port: string,
  authFile: string | undefined,
  route: string,
  maxSeconds: number,
  retrySeconds = 0,
  host: HostHeaders = { entrypoint: '', term: '' },
): string[] {
  // Retries, when asked for, also cover HTTP errors (a daemon whose policy
  // engine is still starting answers 400), one a second, for at most
  // retrySeconds in all (curl restarts --max-time for each attempt).
  const retry =
    retrySeconds === 0
      ? []
      : [
          '--fail', '--retry', String(retrySeconds), '--retry-delay', '1',
          '--retry-max-time', String(retrySeconds), '--retry-all-errors',
        ]
  return [
    'curl', '-sS', '--noproxy', '*', '--max-time', String(maxSeconds), ...retry,
    '--max-filesize', '1048576', '-X', 'POST', '-H', 'content-type: application/json',
    '-H', `x-claude-code-entrypoint: ${headerSafe(host.entrypoint) || 'unknown'}`,
    '-H', `x-claude-code-term-program: ${headerSafe(host.term)}`,
    ...(authFile === undefined ? [] : ['-H', `@${authFile}`]),
    '--data-binary', '@-', '--write-out', '\n%{http_code}',
    `http://127.0.0.1:${port}${route}`,
  ]
}

/** curl's arguments for one policy check (/v1/pretooluse). */
export function checkArgv(port: string, authFile: string | undefined, host?: HostHeaders): string[] {
  return postArgv(port, authFile, '/v1/pretooluse', 10, 0, host)
}

/** Splits curl's output into the body and the HTTP status it appended. */
export function splitStatus(stdout: string): { body: string; status: string } {
  const cut = stdout.lastIndexOf('\n')
  return { body: stdout.slice(0, Math.max(cut, 0)), status: stdout.slice(cut + 1) }
}

const isRecord = (v: unknown): v is Record<string, unknown> =>
  typeof v === 'object' && v !== null && !Array.isArray(v)

/**
 * The daemon's hook output as a `classic.PreToolUse` result, or undefined when
 * it is not one. The accepted shapes are exactly the daemon's: `{}` (no
 * objection), or `{ hookSpecificOutput }` with `hookEventName: "PreToolUse"`,
 * an optional decision with its reason, and an optional input rewrite and
 * context note, each of its own type, with at least one of decision, rewrite
 * or note. Anything else fails closed rather than passing a call the backup
 * hook would then skip.
 */
export function toResult(body: string): PreToolUseResult | undefined {
  return parseAnswer(body)?.result
}

/**
 * A daemon answer as the decision and, beside a denial, the one-time bypass it
 * offers (`sasyApproval`, sent only to a client that set `sasy_mod`). Undefined
 * when the answer is not one of the daemon's exact shapes: that fails closed.
 */
export function parseAnswer(body: string): CheckAnswer | undefined {
  let out: unknown
  try {
    out = JSON.parse(body)
  } catch {
    return undefined
  }
  if (!isRecord(out)) return undefined
  const { sasyApproval, ...rest } = out
  const keys = Object.keys(rest)
  const offer = sasyApproval === undefined ? undefined : offerOf(sasyApproval)
  if (sasyApproval !== undefined && offer === undefined) return undefined
  if (keys.length === 0) return offer === undefined ? { result: {} } : undefined
  if (keys.length !== 1 || !isRecord(rest.hookSpecificOutput)) return undefined
  const result = decisionOf(rest.hookSpecificOutput)
  if (result === undefined) return undefined
  // An offer rides only on a denial.
  if (offer !== undefined && result.deny === undefined) return undefined
  return offer === undefined ? { result } : { result, offer }
}

/** A `hookSpecificOutput` block as a `classic.PreToolUse` result, or undefined. */
function decisionOf(block: Record<string, unknown>): PreToolUseResult | undefined {
  const {
    hookEventName,
    permissionDecision: decision,
    permissionDecisionReason: reason,
    updatedInput,
    additionalContext: note,
    ...unknown
  } = block
  const isValid =
    Object.keys(unknown).length === 0 &&
    hookEventName === 'PreToolUse' &&
    (decision === undefined || decision === 'allow' || decision === 'ask' || decision === 'deny') &&
    (reason === undefined || typeof reason === 'string') &&
    (updatedInput === undefined || isRecord(updatedInput)) &&
    (note === undefined || typeof note === 'string') &&
    (decision !== undefined || updatedInput !== undefined || note !== undefined)
  if (!isValid) return undefined
  const why = typeof reason === 'string' ? reason : ''
  const decided: PreToolUseResult =
    decision === 'deny'
      ? { deny: why || '[SASY] denied by policy' }
      : decision === 'ask'
        ? { ask: why || '[SASY] approval needed' }
        : {} // an `allow` too: SASY never skips Claude Code's own permission prompt
  return {
    ...decided,
    ...(isRecord(updatedInput) ? { updatedInput } : {}),
    ...(typeof note === 'string' && note !== '' ? { additionalContext: [note] } : {}),
  }
}

/** SASY's denial, keeping the context notes other hooks added to the call. */
export function denyWith(ours: PreToolUseResult & { deny: string }, theirs: PreToolUseResult): PreToolUseResult {
  const context = [...(ours.additionalContext ?? []), ...(theirs.additionalContext ?? [])]
  return { deny: ours.deny, ...(context.length === 0 ? {} : { additionalContext: context }) }
}

/** One answer from several PreToolUse deciders: deny over ask over allow. */
export function combine(ours: PreToolUseResult, theirs: PreToolUseResult): PreToolUseResult {
  const context = [...(ours.additionalContext ?? []), ...(theirs.additionalContext ?? [])]
  // SASY's rewrite is part of what it authorised, so it wins over another
  // hook's rewrite of the same call.
  const updatedInput = ours.updatedInput ?? theirs.updatedInput
  if (theirs.deny !== undefined) return denyWith({ ...theirs, deny: theirs.deny }, ours)
  const extra = {
    ...(updatedInput === undefined ? {} : { updatedInput }),
    ...(context.length === 0 ? {} : { additionalContext: context }),
  }
  if (ours.ask !== undefined) return { ask: ours.ask, ...extra }
  if (theirs.ask !== undefined) return { ask: theirs.ask, ...extra }
  if (theirs.allow === true) return { allow: true, ...extra }
  return extra
}

/** curl exits that mean the daemon did not answer: could not connect (7),
 *  partial reply (18), timed out (28), empty reply (52), the connection dropped
 *  while sending (55) or receiving (56). */
export const UNREACHABLE_CURL_EXITS = [7, 18, 28, 52, 55, 56]

/** A check's reply: the daemon's body, or why there is none and of what kind. */
export type CheckReply = { body: string } | { error: string; kind: 'unreachable' | 'auth' | 'answer' }

/** What a check's curl run came to. Only a daemon that is down or not
 *  answering is "unreachable" (the one failure SASY_FAIL_OPEN covers); curl
 *  failing otherwise, as on an auth header file it cannot read, is not. */
export function replyOf(ran: { exitCode: number; stdout: string }, port: string): CheckReply {
  if (ran.exitCode !== 0) {
    const kind = UNREACHABLE_CURL_EXITS.includes(ran.exitCode) ? 'unreachable' : 'answer'
    return { error: `curl exit ${ran.exitCode} on port ${port}`, kind }
  }
  const { body, status } = splitStatus(ran.stdout)
  if (status === '200') return { body }
  const kind = status === '401' || status === '403' ? 'auth' : 'answer'
  return { error: `sasy-watch answered HTTP ${status}`, kind }
}
