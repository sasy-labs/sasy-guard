// What the mod keeps across a reset of $.state: Claude Code clears a plugin's
// session values at /clear, /resume and compaction without a new
// session.start. Pure, so the tests can hold it to its rules.
import type { GuardCounts, GuardDecision } from '../types'
import type { AgentTable } from './agents'

/** The most worktree ids seen before their spawn that the mod remembers. */
export const MAX_EARLY = 200

/** The mod's $.state values that a reset clears. */
export type Carried = {
  agents: AgentTable
  isolatedEarly: string[]
  counts: GuardCounts
  decisions: GuardDecision[]
  dismissedSeq: number
}

/**
 * What to hold after a reset, from what was held before it (`kept`) and what
 * is held now. Subagents keep running across /clear, /resume and compaction,
 * so their records always come back, under any recorded since. The totals and
 * decisions describe one session: they come back only after compaction, which
 * keeps it, and only if nothing was recorded since.
 */
export function carryOver(kept: Carried, now: Carried, source: unknown): Carried {
  const merged: Carried = {
    ...now,
    agents: { ...kept.agents, ...now.agents },
    isolatedEarly: [
      ...kept.isolatedEarly.filter(id => !now.isolatedEarly.includes(id)),
      ...now.isolatedEarly,
    ].slice(-MAX_EARLY),
  }
  const isFresh = now.counts.checked === 0 && now.decisions.length === 0
  if (source !== 'compact' || !isFresh) return merged
  return { ...merged, counts: kept.counts, decisions: kept.decisions, dismissedSeq: kept.dismissedSeq }
}
