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
}

declare module 'claude-code' {
  interface PluginState {
    'artifact-watchdog': { watches: Watch[] }
  }
}
