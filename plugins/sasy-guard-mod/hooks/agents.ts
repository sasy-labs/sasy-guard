// Which agent made a tool call, as the policy check needs to know it.
//
// A settings hook is handed the caller by Claude Code (`agent_id`,
// `agent_type`, `cwd`); a mod's `classic.PreToolUse` is not. The mod rebuilds
// it: `tool.call` names the subagent behind a call, and `agent.spawn` says each
// subagent's type and folder when it starts. A subagent runs in the folder its
// spawn named, else its parent's, else the session's current one (a `cd` inside
// a subagent does not persist between its commands). A subagent given its own
// git worktree runs where the mod cannot see, so its calls are unattributable.
// Pure functions over plain data, so register.tsx can keep the table in $.state.

/** What the mod knows about one subagent. */
export type AgentRecord = {
  /** The resolved agent type, as the hook payload's `agent_type`. */
  type: string
  /** The folder its spawn named, or null for the session's current folder. */
  cwd: string | null
  /** True when the mod cannot tell where it runs (worktree, unknown parent). */
  isUnattributable: boolean
}

/** The subagents seen this session, by agent id. */
export type AgentTable = Readonly<Record<string, AgentRecord>>

/** What `agent.spawn` says about a subagent that started. */
export type Spawn = {
  agentId: string
  subagentType: string
  cwd?: string
  parentAgentId?: string
  isTeammate?: boolean
  /** A teammate's name in its team, which its hook payloads give as `agent_type`. */
  teammateName?: string
}

/** The caller of one tool call, or why the mod cannot name it. */
export type Caller =
  | { kind: 'main' }
  | { kind: 'agent'; agentId: string; type: string; cwd: string | null }
  | { kind: 'unknown'; why: string }

/** The agent id in the name Claude Code gives a subagent's worktree. */
export function worktreeAgentId(name: string): string | undefined {
  const match = /^agent-([A-Za-z0-9]{1,64})$/.exec(name)
  return match?.[1]
}

/**
 * The subagent a WorktreeCreate puts in a folder of its own, if any: the one
 * that entered it (its `agent_id`, as for EnterWorktree under any name), else
 * the isolated subagent its `agent-<id>` name was made for. None for the main
 * thread's own worktree, which the session's folder follows.
 */
export function worktreeOwner(event: { name?: unknown; agent_id?: unknown }): string | undefined {
  if (typeof event.agent_id === 'string' && event.agent_id !== '') return event.agent_id
  return typeof event.name === 'string' ? worktreeAgentId(event.name) : undefined
}

/**
 * The table with one more subagent. It inherits its parent's folder when its
 * spawn named none, and is unattributable when it runs isolated or its parent
 * is unknown or unattributable. A teammate runs in the session's folder.
 */
export function addSpawn(table: AgentTable, spawn: Spawn, isIsolated: boolean): AgentTable {
  const parent = spawn.parentAgentId === undefined ? undefined : table[spawn.parentAgentId]
  const isParentUnknown =
    spawn.parentAgentId !== undefined && (parent === undefined || parent.isUnattributable)
  const inherited = parent?.cwd ?? null
  const cwd = spawn.isTeammate === true ? null : spawn.cwd ?? inherited
  const record: AgentRecord = {
    type: spawn.teammateName ?? spawn.subagentType,
    cwd,
    isUnattributable: isIsolated || isParentUnknown,
  }
  return { ...table, [spawn.agentId]: record }
}

/** The table with one subagent marked unattributable (its worktree appeared). */
export function markUnattributable(table: AgentTable, agentId: string): AgentTable {
  const record = table[agentId]
  if (record === undefined) return table
  return { ...table, [agentId]: { ...record, isUnattributable: true } }
}

/** Who made a call, given the subagent `tool.call` named (none: the main thread). */
export function attribute(table: AgentTable, agentId: string | undefined): Caller {
  if (agentId === undefined) return { kind: 'main' }
  const record = table[agentId]
  if (record === undefined) {
    return { kind: 'unknown', why: 'a subagent that started before this mod loaded' }
  }
  if (record.isUnattributable) {
    return { kind: 'unknown', why: 'a subagent in its own worktree, whose folder the mod cannot see' }
  }
  return { kind: 'agent', agentId, type: record.type, cwd: record.cwd }
}
