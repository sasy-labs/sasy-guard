// The policy check's pure parts: the request the mod sends the sasy-watch
// daemon's /v1/pretooluse route (the settings hook's own payload), and how the
// daemon's answer becomes a `classic.PreToolUse` result. register.tsx makes the
// calls, since only it may hold the engine interface.
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
  /** A session started with --agent: its agent type, as the hook receives it. */
  agent_type?: string
}

/**
 * curl's arguments for one check: bounded in time and size, never via a proxy,
 * the body on stdin, the HTTP status appended on a line of its own. A daemon
 * that authenticates hooks is sent its header file with `-H @file`, so the
 * secret never appears in a process's arguments.
 */
export function checkArgv(port: string, authFile: string | undefined): string[] {
  return [
    'curl', '-sS', '--noproxy', '*', '--max-time', '10', '--max-filesize', '1048576',
    '-X', 'POST', '-H', 'content-type: application/json',
    '-H', 'x-claude-code-entrypoint: sasy-guard-mod',
    ...(authFile === undefined ? [] : ['-H', `@${authFile}`]),
    '--data-binary', '@-', '--write-out', '\n%{http_code}',
    `http://127.0.0.1:${port}/v1/pretooluse`,
  ]
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
  let out: unknown
  try {
    out = JSON.parse(body)
  } catch {
    return undefined
  }
  if (!isRecord(out)) return undefined
  const keys = Object.keys(out)
  if (keys.length === 0) return {}
  if (keys.length !== 1 || !isRecord(out.hookSpecificOutput)) return undefined
  const {
    hookEventName,
    permissionDecision: decision,
    permissionDecisionReason: reason,
    updatedInput,
    additionalContext: note,
    ...unknown
  } = out.hookSpecificOutput
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
        : decision === 'allow'
          ? { allow: true }
          : {}
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
  if (theirs.deny !== undefined) return theirs
  const context = [...(ours.additionalContext ?? []), ...(theirs.additionalContext ?? [])]
  // SASY's rewrite is part of what it authorised, so it wins over another
  // hook's rewrite of the same call.
  const updatedInput = ours.updatedInput ?? theirs.updatedInput
  const extra = {
    ...(updatedInput === undefined ? {} : { updatedInput }),
    ...(context.length === 0 ? {} : { additionalContext: context }),
  }
  if (ours.ask !== undefined) return { ask: ours.ask, ...extra }
  if (theirs.ask !== undefined) return { ask: theirs.ask, ...extra }
  if (ours.allow === true || theirs.allow === true) return { allow: true, ...extra }
  return extra
}
