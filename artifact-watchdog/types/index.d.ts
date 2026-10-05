// waiting: dispatched, file not seen yet. growing: file grew within the window.
// stalled: no growth for the stall window. complete: last line is AGENT COMPLETE.
// stopping: Stop pressed, TaskStop not answered yet. stopped: TaskStop answered.
// ended: the agent finished (or was stopped elsewhere) without writing AGENT COMPLETE.
// missing: the prompt named no artifact path.
export type WatchStatus =
  | 'waiting'
  | 'growing'
  | 'stalled'
  | 'stopping'
  | 'complete'
  | 'stopped'
  | 'ended'
  | 'missing'

export type Watch = {
  id: string
  label: string
  path: string | null
  agentId: string | null
  startedAt: number
  lastSize: number
  lastGrowthAt: number
  status: WatchStatus
  summary: string
  // When the watch first went stalled; kept after it recovers or completes.
  stalledAt?: number
  // The one wake the latest stall earned; replaced when the watch stalls again.
  wake?: Wake
}

// pending: stalled, waiting for the main loop to be idle. queued: prompt
// submitted, its turn not started yet. sent: its turn started. failed: the
// submit was dropped or threw. off: stalled while /watchdog wake was off.
export type WakeState = 'pending' | 'queued' | 'sent' | 'failed' | 'off'

export type Wake = {
  state: WakeState
  detail: string
}

declare module 'claude-code' {
  interface PluginState {
    // wake: whether a stall may start a turn of its own (default on).
    'artifact-watchdog': { watches: Watch[]; wake: boolean }
  }
}
