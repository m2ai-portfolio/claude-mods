// Artifact Watchdog: the point-of-action half of
// ~/.claude/rules/subagent-output-contract.md clause 3 ("Bounded").
//
// tool.call (Agent): pull the artifact path out of the dispatch prompt and
// start a watch; keep the async agentId so the pane can TaskStop it.
// session.start: register /watchdog and start the poll timer.
// Every TICK_MS: stat each live artifact. A write since dispatch resets the
// clock, and a last line of "AGENT COMPLETE" closes the watch. The file is
// stat'ed at dispatch first: a reused path (re-dispatching the same task
// overwrites the same slug) may already end with an earlier run's marker, and
// only a write by this dispatch may close its watch. STALL_MS without growth is only half
// a stall: the agent may be alive and busy (a long test run) without
// appending. So the agent's own activity is tracked too, from the events that
// carry its agentId: tool.call (start, and its end when next resolves),
// turn.step (a model request, start and end) and turn.complete. A tool call
// or request still in flight counts as active for up to IN_FLIGHT_CAP_MS, so a
// 6-minute build is not silence but a hung tool still trips. Quiet file +
// active agent = "quiet": shown on the row, no toast, note or wake. Quiet
// file + agent silent for SILENT_MS = stalled: toast, open the pane, plus a
// note Claude reads on its next request. Activity after a stall clears it
// back to quiet. A watch with no agentId (a foreground agent) has no activity
// to read and keeps the file-only rule.
// An agent that finishes without the marker ends its watch ("ended"), so a
// dead agent's row never turns into a false stall.
// Wake: a note waits for Claude's next request, and an idle main loop (it
// dispatched a background agent and ended its turn) makes none. So each stall
// also earns ONE $.prompt.submit, a turn of its own: at once when the main
// loop is idle, else at that turn's end if the agent is still stalled and
// running. $.session.send cannot do this: the engine refuses a send to its
// own session. turn.start / turn.complete track whether the main loop is busy.
// /watchdog wake off|on is the switch (session state, default on).
// ui.render (Pane): one row per watch, a Stop button on stalled agents.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { InFlight, Wake, Watch, WatchStatus } from '../types'

const PANE = 'artifact-watchdog'
const TICK_MS = 15_000
const STALL_MS = 5 * 60_000
// How long an agent may go without any event before it counts as silent.
const SILENT_MS = 2 * 60_000
// How long one tool call or model request may run and still count as activity.
const IN_FLIGHT_CAP_MS = 15 * 60_000
// An agent's activity record is dropped once it has been idle this long.
const ACTIVITY_TTL_MS = 60 * 60_000
// How long a pressed Stop may wait on TaskStop (a permission ask, a busy loop)
// before Claude is told to stop the agent itself.
const STOP_WAIT_MS = 30_000
// Same pattern as ~/.claude/hooks/agent-output-contract.py ARTIFACT_RE.
const ARTIFACT_RE = /(~|\/home\/apexaipc)\/\.claude\/agents\/\.artifacts\/[\w./-]+\.md/
const MARKER_RE = /^AGENT COMPLETE:?\s*(.*)$/

const watches = atom({ plugin: 'artifact-watchdog', key: 'watches' } as const, [])
const wakeOn = atom({ plugin: 'artifact-watchdog', key: 'wake' } as const, true)

let home = '/home/apexaipc'
let isTicking = false
// The main loop's running turn, or null when it is idle. A reload starts at
// null, which holds: a hot reload lands when a turn ends.
let mainTurn: string | null = null

// Per subagent id: its last event and the calls it has running, keyed per
// call. Module memory, written on every event and copied into the watches at
// each poll (one state write per tick, not per event). A reload forgets the
// calls in flight; the copied lastActivityAt carries over.
type Activity = { lastAt: number; ops: Map<string, InFlight> }
const activity = new Map<string, Activity>()
let opSeq = 0

export const register: Register = on => {
  // Every subagent tool call, start to finish. Outermost, so it times the
  // whole call (a permission ask included).
  on('tool.call', async ($, e, next) => {
    if (e.agentId === undefined) {
      return next(e)
    }
    const done = await begin($, e.agentId, e.tool_use_id ?? `call-${++opSeq}`, e.tool)
    try {
      return await next(e)
    } finally {
      await done()
    }
  })

  // A subagent's model request: thinking and writing a long tool input can
  // take minutes with no tool call to show for it.
  on('turn.step', async function* ($, e, next) {
    if (e.agentId === undefined) {
      return yield* next(e)
    }
    const done = await begin($, e.agentId, `step-${e.turnId}-${e.index}`, 'model request')
    try {
      return yield* next(e)
    } finally {
      await done()
    }
  })

  on('session.start', async ($, e, next) => {
    const result = await next(e)
    home = (await $.env.get('HOME')) ?? home
    await $.command.register({
      name: 'watchdog',
      description: 'Show subagent artifact files and flag any that stopped growing',
    })
    $.clock.every(TICK_MS, () => {
      void tick($)
    })
    await tick($)

    return result
  })

  // /watchdog opens the pane; /watchdog wake [on|off] reads or sets the wake.
  on('command.run', { command: 'watchdog' }, async ($, e) => {
    // args is "" for a bare /watchdog; another plugin's $.command.run may omit it.
    const words = (e.args ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean)
    if (words[0] === 'wake' && (words[1] === 'on' || words[1] === 'off') && words.length === 2) {
      await update($, wakeOn, () => words[1] === 'on')
      if (words[1] === 'off') {
        await cancelPendingWakes($)
      }
      return { text: `Artifact watchdog: wake on stall is ${words[1]}.` }
    }
    if (words[0] === 'wake' && words.length === 1) {
      return { text: `Artifact watchdog: wake on stall is ${(await isWakeOn($)) ? 'on' : 'off'}.` }
    }
    if (words.length > 0) {
      return { text: 'Usage: /watchdog (open the pane) · /watchdog wake [on|off]' }
    }
    await $.ui.open({ id: PANE, title: 'Artifact watchdog' })

    return { text: `Artifact watchdog pane opened. Wake on stall: ${(await isWakeOn($)) ? 'on' : 'off'}.` }
  })

  // Busy or idle: a main-loop turn runs from turn.start to its turn.complete.
  // A subagent's run raises no turn.start, and its turn.complete has agentId.
  on('turn.start', ($, e, next) => {
    mainTurn = e.turnId
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId === undefined) {
      mainTurn = null
      // A stall noted mid-turn may never have been read: wake for it now.
      await decideWakes($)
    } else {
      touch(e.agentId, await $.clock.now())
    }

    return result
  })

  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    const now = await $.clock.now()
    const match = ARTIFACT_RE.exec(String(e.prompt ?? ''))
    const path = match ? match[0].replace(/^~/, home) : null
    // What is at the path before the agent starts: the baseline a write must change.
    const before = path === null ? undefined : await $.fs.stat(path).catch(() => undefined)
    const isFile = before?.kind === 'file'
    const watch: Watch = {
      id: e.tool_use_id ?? `agent-${now}`,
      label: String(e.description ?? 'agent'),
      path,
      agentId: null,
      startedAt: now,
      lastSize: isFile ? before.size : 0,
      lastMtimeMs: isFile ? before.mtimeMs : null,
      lastGrowthAt: now,
      status: match ? 'waiting' : 'missing',
      summary: match ? '' : 'prompt names no artifact path',
      lastActivityAt: now,
      inFlight: null,
    }
    await update($, watches, list => [...list.filter(w => w.id !== watch.id), watch].slice(-50))
    showStatus($, await currentWatches($))

    const ran = await next(e)
    const launched = ran.result as { status?: string; agentId?: string } | undefined
    if (launched?.status === 'async_launched' && launched.agentId) {
      const agentId = launched.agentId
      await update($, watches, list => list.map(w => (w.id === watch.id ? { ...w, agentId } : w)))
    } else {
      // A foreground agent has finished: check its file now, not in 15s. If the
      // marker is still absent the watch ends here, or it would stall later.
      await tick($)
      await update($, watches, list =>
        list.map(w => (w.id === watch.id && isLive(w) ? endedWatch(w, 'finished') : w)),
      )
      showStatus($, await currentWatches($))
    }

    return ran
  })

  on('ui.render', { component: 'Pane', requestId: PANE }, async ($, e) => {
    const { Box, Text, Button } = $.ui.resolve(e)
    const list = await read($, watches)
    const isWaking = await read($, wakeOn)
    const now = await $.clock.now()
    const room = Math.max(1, (e.viewport?.rows ?? 24) - 4)
    const isDone = (w: Watch) => w.status === 'complete' || w.status === 'stopped' || w.status === 'ended'

    return (
      <Box flexDirection="column">
        <Box flexDirection="row">
          <Text dimColor>
            Stall after {STALL_MS / 60_000} min without growth and {SILENT_MS / 60_000} min of agent silence ·
            polled every {TICK_MS / 1000}s · wake{' '}
            {isWaking ? 'on' : 'off'}{' '}
          </Text>
          {list.some(isDone) && (
            <Button
              key="clear"
              label="Clear finished"
              plain
              onPress={() => update($, watches, l => l.filter(w => !isDone(w)))}
            />
          )}
        </Box>
        {list.length === 0 && <Text dimColor>No Agent dispatches this session.</Text>}
        {list.slice(-room).map(w => (
          <Box flexDirection="row">
            <Text color={COLOR[w.status]} bold={w.status === 'stalled'}>
              {GLYPH[w.status]} {w.status.padEnd(8)}
            </Text>
            <Text> {w.label} </Text>
            <Text dimColor>
              {detail(w, now)}
            </Text>
            {w.status === 'stalled' && w.agentId !== null && (
              <Button
                key={`stop-${w.id}`}
                label="Stop"
                variant="primary"
                onPress={() => stop($, w)}
              />
            )}
          </Box>
        ))}
      </Box>
    )
  })
}

const GLYPH: Record<WatchStatus, string> = {
  waiting: '…',
  growing: '▲',
  quiet: '◇',
  stalled: '■',
  stopping: '◌',
  complete: '✓',
  stopped: '×',
  ended: '–',
  missing: '?',
}

const COLOR: Record<WatchStatus, string> = {
  waiting: 'gray',
  growing: 'green',
  quiet: 'yellow',
  stalled: 'red',
  stopping: 'yellow',
  complete: 'cyan',
  stopped: 'gray',
  ended: 'yellow',
  missing: 'yellow',
}

function detail(w: Watch, now: number): string {
  if (!isLive(w)) {
    const stalled = w.stalledAt !== undefined && w.status !== 'stopping' ? ' (stalled earlier)' : ''
    // A finished row keeps what its wake came to; a pending one never went out.
    const woke = w.wake && (w.wake.state === 'sent' || w.wake.state === 'failed') ? ` · ${w.wake.detail}` : ''
    return `${w.summary}${stalled}${woke}`
  }
  const idle = Math.round((now - w.lastGrowthAt) / 1000)
  const file = w.path ? w.path.split('/').pop() : ''
  const quiet = w.status === 'quiet' ? ' · quiet file, agent active' : ''
  const woke = w.status === 'stalled' && w.wake ? ` · ${w.wake.detail}` : ''
  const note = w.summary ? ` · ${w.summary}` : ''
  return `${file} · ${kb(w.lastSize)} · idle ${idle}s${agentDetail(w, now)}${quiet}${woke}${note}`
}

// The agent half of a live row: what is running now, else its last event.
function agentDetail(w: Watch, now: number): string {
  if (w.agentId === null) {
    return ''
  }
  if (w.inFlight) {
    return ` · ${w.inFlight.what} running ${Math.round((now - w.inFlight.since) / 1000)}s`
  }
  const at = w.lastActivityAt ?? w.startedAt
  return ` · last activity ${Math.round((now - at) / 1000)}s ago`
}

// Watches the poll still owns. A stopping row belongs to stop() until TaskStop answers.
function isLive(w: Watch): boolean {
  return w.status === 'waiting' || w.status === 'growing' || w.status === 'quiet' || w.status === 'stalled'
}

// Records one call starting in a subagent's loop; the returned function
// records its end. Both count as activity.
async function begin($: EngineInterface, agentId: string, key: string, what: string): Promise<() => Promise<void>> {
  const since = await $.clock.now()
  const record = touch(agentId, since)
  record.ops.set(key, { what, since })
  return async () => {
    record.ops.delete(key)
    touch(agentId, await $.clock.now().catch(() => since))
  }
}

function touch(agentId: string, at: number): Activity {
  const record = activity.get(agentId) ?? { lastAt: at, ops: new Map<string, InFlight>() }
  record.lastAt = Math.max(record.lastAt, at)
  activity.set(agentId, record)
  return record
}

// The agent's activity as of now: its last event, and its newest call still
// running (a later start is the better sign of life).
function activityOf(w: Watch): { lastActivityAt: number; inFlight: InFlight | null } {
  const record = w.agentId === null ? undefined : activity.get(w.agentId)
  const lastActivityAt = Math.max(w.lastActivityAt ?? w.startedAt, record?.lastAt ?? 0)
  let inFlight: InFlight | null = null
  for (const op of record?.ops.values() ?? []) {
    if (inFlight === null || op.since > inFlight.since) {
      inFlight = op
    }
  }
  return { lastActivityAt, inFlight }
}

// Active: an event within SILENT_MS, or a call in flight for under
// IN_FLIGHT_CAP_MS. A watch with no agentId has nothing to read: never active,
// so it keeps the file-only rule.
function isAgentActive(w: Watch, seen: { lastActivityAt: number; inFlight: InFlight | null }, now: number): boolean {
  if (w.agentId === null) {
    return false
  }
  if (seen.inFlight !== null && now - seen.inFlight.since < IN_FLIGHT_CAP_MS) {
    return true
  }
  return now - seen.lastActivityAt < SILENT_MS
}

function endedWatch(w: Watch, agentStatus: string): Watch {
  return { ...w, status: 'ended', summary: `agent ${agentStatus} without AGENT COMPLETE` }
}

function kb(bytes: number): string {
  return bytes >= 1024 ? `${(bytes / 1024).toFixed(1)}k` : `${bytes}b`
}

async function currentWatches($: EngineInterface): Promise<Watch[]> {
  const { value } = await $.state.get({ plugin: 'artifact-watchdog', key: 'watches' } as const)
  return value ?? []
}

async function isWakeOn($: EngineInterface): Promise<boolean> {
  const { value } = await $.state.get({ plugin: 'artifact-watchdog', key: 'wake' } as const)
  return value ?? true
}

function showStatus($: EngineInterface, list: Watch[]): void {
  const growing = list.filter(w => w.status === 'growing' || w.status === 'waiting' || w.status === 'quiet').length
  const stalled = list.filter(w => w.status === 'stalled').length
  if (growing === 0 && stalled === 0) {
    $.ui.status(undefined)
    return
  }
  const parts = [growing > 0 ? `${growing} running` : '', stalled > 0 ? `${stalled} STALLED` : '']
  $.ui.status(`artifacts: ${parts.filter(Boolean).join(' · ')}`)
}

// One poll: stat every live artifact, then merge the readings into state.
async function tick($: EngineInterface): Promise<void> {
  if (isTicking) {
    return
  }
  isTicking = true
  try {
    const now = await $.clock.now()
    const live = (await currentWatches($)).filter(
      w =>
        w.path !== null &&
        (w.status === 'waiting' ||
          w.status === 'growing' ||
          w.status === 'quiet' ||
          w.status === 'stalled' ||
          w.status === 'stopping'),
    )
    const changes = new Map<string, Partial<Watch>>()
    const put = (id: string, change: Partial<Watch>) => changes.set(id, { ...changes.get(id), ...change })
    const newlyStalled: Watch[] = []
    let wakeIsOn: boolean | undefined
    // An async agent that hands back without the marker would otherwise sit
    // here until it "stalls": ask the engine which agents are still running.
    const agents = live.some(w => w.agentId !== null) ? await $.agent.list().catch(() => undefined) : undefined
    const agentStatus = new Map((agents ?? []).map(a => [a.id, a.status]))

    for (const w of live) {
      const status = w.agentId !== null ? agentStatus.get(w.agentId) : undefined
      const hasEnded = isLive(w) && status !== undefined && status !== 'running'
      const path = w.path ?? ''
      const stat = await $.fs.stat(path).catch(() => undefined)
      const size = stat?.kind === 'file' ? stat.size : 0
      const mtimeMs = stat?.kind === 'file' ? stat.mtimeMs : null
      // Written since the last reading: longer, or rewritten (shorter, or the
      // same size with a newer mtime). An unchanged file left by an earlier
      // dispatch never counts, so its old marker cannot close this watch.
      const lastMtimeMs = w.lastMtimeMs ?? null
      const isNewer = mtimeMs !== null && lastMtimeMs !== null && mtimeMs > lastMtimeMs
      const isWritten = size > 0 && (size !== w.lastSize || isNewer)
      if (isWritten) {
        const text: string = await $.fs.read(path).catch(() => '')
        const lastLine = text.trimEnd().split('\n').pop() ?? ''
        const marker = MARKER_RE.exec(lastLine.trim())
        put(
          w.id,
          marker
            ? { status: 'complete', lastSize: size, lastMtimeMs: mtimeMs, lastGrowthAt: now, summary: marker[1] ?? '' }
            : { status: 'growing', lastSize: size, lastMtimeMs: mtimeMs, lastGrowthAt: now, summary: '' },
        )
      }
      const seen = activityOf(w)
      if (isLive(w) && (seen.lastActivityAt !== w.lastActivityAt || seen.inFlight?.since !== w.inFlight?.since)) {
        put(w.id, seen)
      }
      if (hasEnded && changes.get(w.id)?.status !== 'complete') {
        const { status: ended, summary } = endedWatch(w, status ?? 'ended')
        put(w.id, { status: ended, summary })
      } else if (changes.get(w.id)?.status === undefined && isLive(w) && now - w.lastGrowthAt >= STALL_MS) {
        if (isAgentActive(w, seen, now)) {
          // The file is quiet but the agent is working: say so, raise nothing.
          // A stalled row whose agent came back to life clears here too.
          if (w.status !== 'quiet') {
            put(w.id, { status: 'quiet' })
          }
        } else if (w.status !== 'stalled') {
          if (w.lastStallAt !== undefined && w.lastStallAt >= w.lastGrowthAt) {
            // Stalled already since the file last grew, cleared only by agent
            // activity: the same stall back. Keep its wake; raise nothing new,
            // or an agent that flickers between work and silence would wake
            // Claude every few minutes.
            put(w.id, { status: 'stalled' })
          } else {
            // Each stall after growth gets a fresh wake, so one that recovers
            // and stalls again earns one more. The switch is read as the stall
            // lands; decideWakes sends the pending ones.
            wakeIsOn ??= await isWakeOn($)
            put(w.id, {
              status: 'stalled',
              stalledAt: w.stalledAt ?? now,
              lastStallAt: now,
              wake: wakeIsOn ? PENDING : OFF,
            })
            newlyStalled.push(w)
          }
        }
      }
    }
    // Forget agents long idle with nothing running.
    for (const [agentId, record] of activity) {
      if (record.ops.size === 0 && now - record.lastAt > ACTIVITY_TTL_MS) {
        activity.delete(agentId)
      }
    }

    if (changes.size > 0) {
      await update($, watches, list => list.map(w => (changes.has(w.id) ? { ...w, ...changes.get(w.id) } : w)))
    } else if (live.length > 0) {
      // Nothing changed state, so nothing redraws: refresh the idle counters.
      $.ui.invalidate('ui.render')
    }
    showStatus($, await currentWatches($))

    if (newlyStalled.length > 0) {
      // Bring the Stop button to the person instead of waiting for /watchdog.
      await $.ui.open({ id: PANE, title: 'Artifact watchdog' }).catch(() => undefined)
    }
    for (const w of newlyStalled) {
      const mins = Math.round((now - w.lastGrowthAt) / 60_000)
      $.ui.toast(`Stalled: "${w.label}" artifact has not grown in ${mins} min. Stop it from the watchdog pane.`, {
        timeoutMs: 10_000,
      })
      await noteForClaude($, stallMessage(w, mins))
    }
    await decideWakes($)
  } finally {
    isTicking = false
  }
}

const PENDING: Wake = { state: 'pending', detail: 'wake pending until the turn ends' }
const OFF: Wake = { state: 'off', detail: 'wake off' }

function stallMessage(w: Watch, mins: number): string {
  const who = w.agentId ? `"${w.label}" (${w.agentId})` : `"${w.label}"`
  return (
    `[artifact-watchdog] Subagent ${who} artifact ${w.path} has not grown in ${mins} min. ` +
    `Per ~/.claude/rules/subagent-output-contract.md clause 3, it is stuck: ` +
    (w.agentId ? `TaskStop agent ${w.agentId} ` : 'stop it ') +
    'and do the task inline.'
  )
}

// Turns pending wakes into one $.prompt.submit each. Runs after every tick and
// at each main-loop turn's end, and submits only while the main loop is idle,
// for a watch still stalled whose agent the engine still lists as running (one
// Claude already stopped waits for the next tick to mark it ended).
async function decideWakes($: EngineInterface): Promise<void> {
  if (mainTurn !== null) {
    return
  }
  const pending = (await currentWatches($)).filter(w => w.status === 'stalled' && w.wake?.state === 'pending')
  if (pending.length === 0) {
    return
  }
  // A wake goes pending while a turn runs; /watchdog wake off before that turn
  // ends must still hold it back.
  if (!(await isWakeOn($))) {
    await cancelPendingWakes($)
    return
  }
  const agents = pending.some(w => w.agentId !== null) ? await $.agent.list().catch(() => undefined) : undefined
  const running = new Set((agents ?? []).filter(a => a.status === 'running').map(a => a.id))
  const ready = new Set(pending.filter(w => w.agentId === null || running.has(w.agentId)).map(w => w.id))
  const now = await $.clock.now()

  // Claim inside one update, so a tick and a turn end racing here cannot both
  // submit for the same stall.
  const claimed = new Map<string, Watch>()
  await update($, watches, list => {
    claimed.clear()
    return list.map(w => {
      if (!ready.has(w.id) || w.status !== 'stalled' || w.wake?.state !== 'pending') {
        return w
      }
      claimed.set(w.id, w)
      return { ...w, wake: { state: 'queued' as const, detail: 'wake queued' } }
    })
  })

  for (const w of claimed.values()) {
    const mins = Math.round((now - w.lastGrowthAt) / 60_000)
    // Never awaited: it resolves when its turn starts, and this may be a
    // turn.complete hook that the turn has to get past first.
    void $.prompt
      .submit({ text: stallMessage(w, mins) })
      .then(
        ran => settleWake($, w.id, ran.drop !== undefined ? failedWake(ran.drop) : { state: 'sent', detail: 'woke Claude' }),
        (err: unknown) => settleWake($, w.id, failedWake(err instanceof Error ? err.message : String(err))),
      )
      .catch(() => undefined)
  }
}

// Wake off: every wake still pending becomes "off". One already queued has
// gone to the engine and is left to settle.
async function cancelPendingWakes($: EngineInterface): Promise<void> {
  await update($, watches, list => list.map(w => (w.wake?.state === 'pending' ? { ...w, wake: OFF } : w)))
}

function failedWake(reason: string): Wake {
  return { state: 'failed', detail: `wake failed: ${reason}` }
}

// Records what a submit came to, unless a newer stall already replaced the wake.
async function settleWake($: EngineInterface, id: string, wake: Wake): Promise<void> {
  await update($, watches, list => list.map(w => (w.id === id && w.wake?.state === 'queued' ? { ...w, wake } : w)))
}

async function stop($: EngineInterface, w: Watch): Promise<void> {
  if (w.agentId === null) {
    return
  }
  const agentId = w.agentId
  // Show the press at once: a TaskStop held by a permission ask otherwise
  // leaves the row red with no sign the press landed.
  await update($, watches, list =>
    list.map(one => (one.id === w.id ? { ...one, status: 'stopping' as const, summary: 'Stop pressed, waiting on TaskStop' } : one)),
  )
  showStatus($, await currentWatches($))

  let isSettled = false
  const waitTimer = $.clock.after(STOP_WAIT_MS, () => {
    if (isSettled) {
      return
    }
    void (async () => {
      await update($, watches, list =>
        list.map(one =>
          one.id === w.id && one.status === 'stopping'
            ? { ...one, summary: `TaskStop unanswered after ${STOP_WAIT_MS / 1000}s (permission ask?)` }
            : one,
        ),
      )
      await noteForClaude(
        $,
        `[artifact-watchdog] Matthew pressed Stop on stalled subagent "${w.label}" (${agentId}), but TaskStop ` +
          `has not answered in ${STOP_WAIT_MS / 1000}s. TaskStop agent ${agentId} yourself and do the task inline.`,
      )
    })()
  })

  // consent marks this call as the person's own request on the permission path.
  // A call that rejects (no TaskStop, aborted) takes the failure branch too:
  // left uncaught it would strand the row in stopping and escape the press.
  let failure: string | null
  try {
    const ran = await $.tool.call({
      tool: 'TaskStop',
      task_id: agentId,
      consent: `Matthew pressed "Stop" on stalled subagent "${w.label}" (${agentId}) in the artifact-watchdog pane.`,
    })
    failure = ran.deny !== undefined ? `denied: ${ran.deny}` : ran.isError ? `failed: ${ran.text ?? 'error'}` : null
  } catch (err) {
    failure = `threw: ${err instanceof Error ? err.message : String(err)}`
  }
  isSettled = true
  waitTimer.cancel()
  if (failure !== null) {
    // The agent may still be running: back to stalled, so the poll keeps
    // watching it and the Stop button is there to press again.
    const summary = `Stop ${failure}`
    await update($, watches, list =>
      list.map(one => (one.id === w.id && one.status === 'stopping' ? { ...one, status: 'stalled' as const, summary } : one)),
    )
    showStatus($, await currentWatches($))
    $.ui.toast(`Stop on "${w.label}" did not go through (TaskStop ${failure}). Press Stop again or stop it yourself.`, {
      timeoutMs: 10_000,
    })
    await noteForClaude(
      $,
      `[artifact-watchdog] Matthew pressed Stop on stalled subagent "${w.label}" (${agentId}), but TaskStop ` +
        `${failure}. The agent may still be running: TaskStop agent ${agentId} yourself and do the task inline.`,
    )
    return
  }
  const summary = 'stopped from the pane'
  await update($, watches, list =>
    list.map(one => (one.id === w.id && one.status === 'stopping' ? { ...one, status: 'stopped' as const, summary } : one)),
  )
  showStatus($, await currentWatches($))
  await noteForClaude(
    $,
    `[artifact-watchdog] Matthew stopped stalled subagent "${w.label}" (${agentId}) from the watchdog pane ` +
      `(TaskStop: ${summary}). Do the task inline.`,
  )
}

// A user-role row Claude reads on its next request. The append can be refused
// (a plugin above, a run no plugin may shape); the toast and pane still stand.
async function noteForClaude($: EngineInterface, text: string): Promise<void> {
  await $.session
    .append({ message: { type: 'user', content: [{ type: 'text', text }] } })
    .catch(() => undefined)
}
