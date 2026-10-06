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
      // True once a threshold handoff is saved: the model's main-loop tool
      // calls are refused until the context drops below the threshold again.
      isBlocked: boolean
      // /auto-handoff unblock: no block for the rest of this window, even if
      // a handoff still being written saves after the command.
      isLifted: boolean
      // The band's "Retire this session" toggle: the pickup button renames and
      // archives this session instead of clearing it (desktop only).
      isRetiring: boolean
    }
  }
}
