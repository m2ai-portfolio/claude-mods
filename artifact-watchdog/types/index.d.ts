// waiting: dispatched, file not seen yet. growing: file grew within the window.
// quiet: no growth for the stall window, but the agent itself is active (a
// recent tool call or model request, or one still in flight): no alarm.
// stalled: no growth for the stall window AND the agent silent for the silence
// window (or no agent id to watch). complete: last line is AGENT COMPLETE.
// stopping: Stop pressed, TaskStop not answered yet. stopped: TaskStop stopped it
// (a denied or failed TaskStop puts the row back to stalled).
// ended: the agent finished (or was stopped elsewhere) without writing AGENT COMPLETE.
// missing: the prompt named no artifact path.
export type WatchStatus =
  | 'waiting'
  | 'growing'
  | 'quiet'
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
  // The file's mtime at the last reading (at dispatch first), or null when
  // there was no file: with lastSize, what a write by this dispatch changes.
  lastMtimeMs?: number | null
  lastGrowthAt: number
  status: WatchStatus
  summary: string
  // When the watch first went stalled; kept after it recovers or completes.
  stalledAt?: number
  // The one wake the latest stall earned; replaced when the watch stalls again
  // after file growth (a stall resumed after agent activity keeps it).
  wake?: Wake
  // When the latest stall landed: a stall cleared by agent activity alone and
  // back before the file grows is the same stall, not a new one.
  lastStallAt?: number
  // The agent's own last event (a tool call starting or ending, a model
  // request starting or ending, its run ending), copied in at each poll.
  lastActivityAt?: number
  // The agent's newest call still running at the last poll, if any.
  inFlight?: InFlight | null
}

// what: the tool's name, or "model request". since: when it started.
export type InFlight = {
  what: string
  since: number
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
