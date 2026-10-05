// writing: the fork is drafting. saved: handoff.mjs stored it. failed: see detail.
export type HandoffStatus = 'writing' | 'saved' | 'failed'

export type HandoffRun = {
  status: HandoffStatus
  tokens: number
  project: string
  path: string
  detail: string
}

declare module 'claude-code' {
  interface PluginState {
    'auto-handoff': {
      // True until the context crosses the threshold; re-armed when it drops
      // back below (after /clear or a compaction).
      isArmed: boolean
      // How many times this session has crossed; part of the idempotency key.
      crossings: number
      last: HandoffRun | null
      isDismissed: boolean
    }
  }
}
