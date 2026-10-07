// What the mod puts back after compaction: Claude Code may clear a plugin's
// session values ($.state) there without a new session.start, and the totals
// and decisions describe the whole session. Pure, so the tests can hold it to
// its rules. (Subagent records live in the hooks module's memory, which no
// reset clears.)
import type { GuardCounts, GuardDecision } from '../types'

/** The most decisions the mod keeps. */
export const MAX_DECISIONS = 50

/** The mod's $.state values that compaction may clear. */
export type Carried = {
  counts: GuardCounts
  decisions: GuardDecision[]
  dismissedSeq: number
}

/**
 * Whether the values now held are a reset's: the totals only grow, so totals
 * below those read before compaction mean they were cleared.
 */
export function wasReset(kept: GuardCounts, now: GuardCounts): boolean {
  return now.checked < kept.checked
}

/** The totals before the reset plus those recorded since. */
export function addCounts(kept: GuardCounts, now: GuardCounts): GuardCounts {
  return {
    checked: kept.checked + now.checked,
    denied: kept.denied + now.denied,
    asked: kept.asked + now.asked,
  }
}

/** The decisions before the reset, then those recorded since, renumbered after
 *  them so each `seq` stays unique and growing. */
export function joinDecisions(kept: GuardDecision[], now: GuardDecision[]): GuardDecision[] {
  const last = kept[kept.length - 1]?.seq ?? 0
  const since = now.map((d, i) => ({ ...d, seq: last + i + 1 }))
  return [...kept, ...since].slice(-MAX_DECISIONS)
}
