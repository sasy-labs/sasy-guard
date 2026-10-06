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
  agent_id?: string
  agent_type?: string
}

type HookSpecific = {
  permissionDecision?: unknown
  permissionDecisionReason?: unknown
  updatedInput?: unknown
  additionalContext?: unknown
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

/** The daemon's hook output as a `classic.PreToolUse` result, or undefined. */
export function toResult(body: string): PreToolUseResult | undefined {
  let out: unknown
  try {
    out = JSON.parse(body)
  } catch {
    return undefined
  }
  if (typeof out !== 'object' || out === null) return undefined
  const hs = (out as { hookSpecificOutput?: unknown }).hookSpecificOutput
  if (hs === undefined) return {}
  if (typeof hs !== 'object' || hs === null) return undefined
  const { permissionDecision, permissionDecisionReason, updatedInput, additionalContext } =
    hs as HookSpecific
  const reason = typeof permissionDecisionReason === 'string' ? permissionDecisionReason : ''
  const decided: PreToolUseResult =
    permissionDecision === 'deny'
      ? { deny: reason || '[SASY] denied by policy' }
      : permissionDecision === 'ask'
        ? { ask: reason || '[SASY] approval needed' }
        : permissionDecision === 'allow'
          ? { allow: true }
          : {}
  const extra: { updatedInput?: Record<string, unknown>; additionalContext?: string[] } = {}
  if (typeof updatedInput === 'object' && updatedInput !== null && !Array.isArray(updatedInput)) {
    extra.updatedInput = updatedInput as Record<string, unknown>
  }
  if (typeof additionalContext === 'string' && additionalContext !== '') {
    extra.additionalContext = [additionalContext]
  }
  return { ...decided, ...extra }
}

/** One answer from several PreToolUse deciders: deny over ask over allow. */
export function combine(ours: PreToolUseResult, theirs: PreToolUseResult): PreToolUseResult {
  if (theirs.deny !== undefined) return theirs
  const context = [...(ours.additionalContext ?? []), ...(theirs.additionalContext ?? [])]
  const updatedInput = theirs.updatedInput ?? ours.updatedInput
  const extra = {
    ...(updatedInput === undefined ? {} : { updatedInput }),
    ...(context.length === 0 ? {} : { additionalContext: context }),
  }
  if (ours.ask !== undefined) return { ask: ours.ask, ...extra }
  if (theirs.ask !== undefined) return { ask: theirs.ask, ...extra }
  if (ours.allow === true || theirs.allow === true) return { allow: true, ...extra }
  return extra
}
