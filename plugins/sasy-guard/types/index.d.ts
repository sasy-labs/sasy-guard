/** The verdict sasy-guard reached on one tool call. */
export type GuardVerdict = 'deny' | 'ask'

/** One tool call that sasy-guard denied or held for the user's approval. */
export type GuardDecision = {
  /** Increases by one per decision in the session; keys the band. */
  seq: number
  /** Milliseconds since the epoch, from `$.clock.now()`. */
  at: number
  tool: string
  /** The command, path or URL the call acted on, shortened for display. */
  target: string
  verdict: GuardVerdict
  /** The reason the policy gave, with the `[SASY]` prefix removed. */
  reason: string
}

/** Per-session totals over every tool call sasy-guard checked. */
export type GuardCounts = { checked: number; denied: number; asked: number }

declare module 'claude-code' {
  interface PluginState {
    'sasy-guard': {
      counts: GuardCounts
      /** The newest decisions, oldest first, capped in the hooks module. */
      decisions: GuardDecision[]
      /** The `seq` of the decision the user dismissed from the band. */
      dismissedSeq: number
      /** The session's transcript file, from classic.SessionStart; sent with each
       *  check so a restarted daemon can rebuild the session from it. */
      transcriptPath: string | null
    }
  }
}
