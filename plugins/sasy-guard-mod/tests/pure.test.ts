// The hooks' pure helpers, tested without the engine.
import { expect, test } from 'claude-code/testing'

import { addSpawn, attribute, isolatedWorktreeAgent, markUnattributable, worktreeAgentId } from '../hooks/agents'
import { addCounts, joinDecisions } from '../hooks/carry'
import { combine, denyWith, parseAnswer, toResult } from '../hooks/enforce'

test('only the daemon\'s own answer shapes are decisions', () => {
  const block = (hs: object) => JSON.stringify({ hookSpecificOutput: hs })
  expect(toResult('{}')).toEqual({})
  expect(toResult(block({ hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: '[SASY] no' })))
    .toEqual({ deny: '[SASY] no' })
  // SASY never answers allow: Claude Code's permission prompt still applies.
  expect(toResult(block({ hookEventName: 'PreToolUse', permissionDecision: 'allow' }))).toEqual({})
  expect(toResult(block({ hookEventName: 'PreToolUse', updatedInput: { command: 'ls -1' } })))
    .toEqual({ updatedInput: { command: 'ls -1' } })
  // No answer: each of these fails closed.
  expect(toResult('[]')).toBeUndefined()
  expect(toResult('{"error":"x"}')).toBeUndefined()
  expect(toResult(block({ permissionDecision: 'allow' }))).toBeUndefined()
  expect(toResult(block({ hookEventName: 'PreToolUse' }))).toBeUndefined()
  expect(toResult(block({ hookEventName: 'PreToolUse', permissionDecision: 'block' }))).toBeUndefined()
  expect(toResult(block({ hookEventName: 'PreToolUse', updatedInput: null }))).toBeUndefined()
  expect(toResult(block({ hookEventName: 'PreToolUse', additionalContext: 7 }))).toBeUndefined()
  expect(toResult(block({ hookEventName: 'PreToolUse', permissionDecision: 'allow', extra: 1 }))).toBeUndefined()
})

test('SASY\'s input rewrite wins over another hook\'s', () => {
  const ours = { updatedInput: { command: 'aws --profile restricted s3 ls' } }
  const theirs = { updatedInput: { command: 'aws s3 ls', timeout: 5 } }
  expect(combine(ours, theirs).updatedInput).toEqual(ours.updatedInput)
  expect(combine({}, theirs).updatedInput).toEqual(theirs.updatedInput)
  expect(combine(ours, { deny: 'no' })).toEqual({ deny: 'no' })
  expect(combine({ additionalContext: ['sasy note'] }, { deny: 'org: no' })).toEqual({
    deny: 'org: no',
    additionalContext: ['sasy note'],
  })
})

test('a SASY denial keeps the context notes of other hooks', () => {
  const merged = denyWith(
    { deny: '[SASY] no', additionalContext: ['sasy note'] },
    { additionalContext: ['org: open an incident ticket'] },
  )
  expect(merged).toEqual({ deny: '[SASY] no', additionalContext: ['sasy note', 'org: open an incident ticket'] })
})

test('a subagent runs where its spawn said, else its parent\'s folder, else the session\'s', () => {
  let table = addSpawn({}, { agentId: 'a1', subagentType: 'general-purpose' }, false)
  table = addSpawn(table, { agentId: 'a2', subagentType: 'Explore', cwd: '/repo/sub' }, false)
  table = addSpawn(table, { agentId: 'a3', subagentType: 'fork', parentAgentId: 'a2' }, false)
  table = addSpawn(
    table,
    { agentId: 'a4', subagentType: 'general-purpose', cwd: '/x', isTeammate: true, teammateName: 'scout-2' },
    false,
  )

  expect(attribute(table, undefined)).toEqual({ kind: 'main' })
  expect(attribute(table, 'a1')).toEqual({ kind: 'agent', agentId: 'a1', type: 'general-purpose', cwd: null })
  expect(attribute(table, 'a2')).toEqual({ kind: 'agent', agentId: 'a2', type: 'Explore', cwd: '/repo/sub' })
  expect(attribute(table, 'a3')).toEqual({ kind: 'agent', agentId: 'a3', type: 'fork', cwd: '/repo/sub' })
  // A teammate is named as its hook payloads name it, and runs where its spawn said.
  expect(attribute(table, 'a4')).toEqual({ kind: 'agent', agentId: 'a4', type: 'scout-2', cwd: '/x' })
})

test('subagents the mod cannot place are unattributable', () => {
  let table = addSpawn({}, { agentId: 'w1', subagentType: 'general-purpose' }, true)
  table = addSpawn(table, { agentId: 'c1', subagentType: 'Explore', parentAgentId: 'w1' }, false)
  table = addSpawn(table, { agentId: 'o1', subagentType: 'Explore', parentAgentId: 'gone' }, false)
  table = addSpawn(table, { agentId: 'm1', subagentType: 'Explore' }, false)
  table = markUnattributable(table, 'm1')

  for (const id of ['w1', 'c1', 'o1', 'm1', 'never-seen']) {
    expect(attribute(table, id).kind).toBe('unknown')
  }
  expect(worktreeAgentId('agent-adf75aa4c2affa6f1')).toBe('adf75aa4c2affa6f1')
  expect(worktreeAgentId('my-branch')).toBeUndefined()
})

test('only the daemon\'s own offer shape is a bypass offer', () => {
  const deny = { hookEventName: 'PreToolUse', permissionDecision: 'deny', permissionDecisionReason: '[SASY] no' }
  const offer = {
    question: 'Approve? [SASY-ALLOW:ab]',
    labels: ['approve', 'decline'],
    reason: 'no',
    policyReason: '[SASY] no\nFix: do not',
  }
  const answer = (o: unknown, hs: unknown = deny) =>
    parseAnswer(JSON.stringify({ hookSpecificOutput: hs, sasyApproval: o }))
  expect(answer(offer)?.offer).toEqual(offer)
  expect(answer({ ...offer, labels: ['approve', 'decline', 'trust-domain'], domain: 'get.example' })?.offer?.domain)
    .toBe('get.example')
  // Each of these is no answer at all, so the call fails closed.
  expect(answer({ ...offer, labels: ['approve'] })).toBeUndefined()
  expect(answer({ ...offer, labels: ['approve', 'decline', 'trust-domain'] })).toBeUndefined()
  expect(answer({ ...offer, extra: 1 })).toBeUndefined()
  // A question without the daemon's routing tag at its end is not one it asked.
  expect(answer({ ...offer, question: 'Approve?' })).toBeUndefined()
  expect(answer({ ...offer, question: 'Approve? [SASY-ALLOW:ab] now' })).toBeUndefined()
  // Nor is one with nothing readable besides the tag.
  expect(answer({ ...offer, question: '\u200b [SASY-ALLOW:ab]' })).toBeUndefined()
  expect(answer({ ...offer, question: '\u115f\u3164 [SASY-ALLOW:ab]' })).toBeUndefined()
  // Only the daemon's two exact choice lists, never a repeated or reordered one.
  expect(answer({ ...offer, labels: Array(1000).fill('approve').concat('decline') })).toBeUndefined()
  expect(answer({ ...offer, labels: ['decline', 'approve'] })).toBeUndefined()
  expect(answer({ ...offer, labels: [['approve'], ['decline']] })).toBeUndefined()
  expect(answer({ ...offer, labels: ['approve,decline'] })).toBeUndefined()
  // A host to trust is a host name as the daemon derives one, kept whole.
  const long = `${'a'.repeat(240)}.example.com`
  const trust = { ...offer, labels: ['approve', 'decline', 'trust-domain'] }
  expect(answer({ ...trust, domain: long })?.offer?.domain).toBe(long)
  expect(answer({ ...trust, domain: `${'a'.repeat(250)}.com` })).toBeUndefined()
  expect(answer({ ...trust, domain: 'Get.Example' })).toBeUndefined()
  expect(answer({ ...trust, domain: 'localhost' })).toBeUndefined()
  expect(answer({ ...trust, domain: '.example.com' })).toBeUndefined()
  expect(answer({ ...trust, domain: 'get.example\u202e' })).toBeUndefined()
  const { policyReason: _dropped, ...withoutPolicy } = offer
  expect(answer(withoutPolicy)).toBeUndefined()
  expect(answer(offer, { hookEventName: 'PreToolUse', updatedInput: { command: 'ls' } })).toBeUndefined()
  expect(parseAnswer(JSON.stringify({ sasyApproval: offer }))).toBeUndefined()
})

test('a worktree named for an isolated subagent marks that subagent', () => {
  expect(isolatedWorktreeAgent({ name: 'agent-adf75aa4c2affa6f1' })).toBe('adf75aa4c2affa6f1')
  // A subagent entering a worktree itself is handled at its EnterWorktree call.
  expect(isolatedWorktreeAgent({ name: 'scratch', agent_id: 'a1' })).toBeUndefined()
  expect(isolatedWorktreeAgent({ name: 'agent-adf75aa4c2affa6f1', agent_id: 'a9' })).toBeUndefined()
  // The main thread's own worktree: the session's folder follows it.
  expect(isolatedWorktreeAgent({ name: 'scratch' })).toBeUndefined()
})

test('compaction puts back the totals and decisions a reset cleared, merged', () => {
  const d = (seq: number, target: string) =>
    ({ seq, at: 0, tool: 'Bash', target, verdict: 'deny', reason: 'r' }) as never
  const kept = { checked: 3, denied: 1, asked: 0 }
  // What was recorded since the reset is kept, added to what came before.
  expect(addCounts(kept, { checked: 1, denied: 0, asked: 1 })).toEqual({ checked: 4, denied: 1, asked: 1 })
  const joined = joinDecisions([d(7, 'a'), d(8, 'b')], [d(1, 'c')])
  expect(joined.map(x => [(x as { seq: number }).seq, (x as { target: string }).target])).toEqual([
    [7, 'a'],
    [8, 'b'],
    [9, 'c'],
  ])
  expect(joinDecisions(Array.from({ length: 50 }, (_, i) => d(i + 1, 'k')), [d(1, 'n')])).toHaveLength(50)
})
