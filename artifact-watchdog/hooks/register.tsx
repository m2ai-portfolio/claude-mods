// Artifact Watchdog: the point-of-action half of
// ~/.claude/rules/subagent-output-contract.md clause 3 ("Bounded").
//
// tool.call (Agent): pull the artifact path out of the dispatch prompt and
// start a watch; keep the async agentId so the pane can TaskStop it.
// session.start: register /watchdog and start the poll timer.
// Every TICK_MS: stat each live artifact. Growth resets the clock, a last line
// of "AGENT COMPLETE" closes the watch, and STALL_MS without growth marks it
// stalled: toast, open the pane, plus a note Claude reads on its next request.
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

import type { Wake, Watch, WatchStatus } from '../types'

const PANE = 'artifact-watchdog'
const TICK_MS = 15_000
const STALL_MS = 5 * 60_000
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

export const register: Register = on => {
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
    }

    return result
  })

  on('tool.call', { tool: 'Agent' }, async ($, e, next) => {
    const now = await $.clock.now()
    const match = ARTIFACT_RE.exec(String(e.prompt ?? ''))
    const watch: Watch = {
      id: e.tool_use_id ?? `agent-${now}`,
      label: String(e.description ?? 'agent'),
      path: match ? match[0].replace(/^~/, home) : null,
      agentId: null,
      startedAt: now,
      lastSize: 0,
      lastGrowthAt: now,
      status: match ? 'waiting' : 'missing',
      summary: match ? '' : 'prompt names no artifact path',
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
            Stall after {STALL_MS / 60_000} min without growth · polled every {TICK_MS / 1000}s · wake{' '}
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
  const woke = w.status === 'stalled' && w.wake ? ` · ${w.wake.detail}` : ''
  return `${file} · ${kb(w.lastSize)} · idle ${idle}s${woke}`
}

// Watches the poll still owns. A stopping row belongs to stop() until TaskStop answers.
function isLive(w: Watch): boolean {
  return w.status === 'waiting' || w.status === 'growing' || w.status === 'stalled'
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
  const growing = list.filter(w => w.status === 'growing' || w.status === 'waiting').length
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
        (w.status === 'waiting' || w.status === 'growing' || w.status === 'stalled' || w.status === 'stopping'),
    )
    const changes = new Map<string, Partial<Watch>>()
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
      if (size > w.lastSize) {
        const text: string = await $.fs.read(path).catch(() => '')
        const lastLine = text.trimEnd().split('\n').pop() ?? ''
        const marker = MARKER_RE.exec(lastLine.trim())
        changes.set(
          w.id,
          marker
            ? { status: 'complete', lastSize: size, lastGrowthAt: now, summary: marker[1] ?? '' }
            : { status: 'growing', lastSize: size, lastGrowthAt: now },
        )
      }
      if (hasEnded && changes.get(w.id)?.status !== 'complete') {
        const { status: ended, summary } = endedWatch(w, status ?? 'ended')
        changes.set(w.id, { ...changes.get(w.id), status: ended, summary })
      } else if (
        !changes.has(w.id) &&
        (w.status === 'waiting' || w.status === 'growing') &&
        now - w.lastGrowthAt >= STALL_MS
      ) {
        // Each stall gets a fresh wake, so one that recovers and stalls again
        // earns one more. The switch is read as the stall lands; decideWakes
        // sends the pending ones.
        wakeIsOn ??= await isWakeOn($)
        changes.set(w.id, { status: 'stalled', stalledAt: w.stalledAt ?? now, wake: wakeIsOn ? PENDING : OFF })
        newlyStalled.push(w)
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
  const ran = await $.tool.call({
    tool: 'TaskStop',
    task_id: agentId,
    consent: `Matthew pressed "Stop" on stalled subagent "${w.label}" (${agentId}) in the artifact-watchdog pane.`,
  })
  isSettled = true
  waitTimer.cancel()
  const summary = ran.deny ?? (ran.isError ? `TaskStop failed: ${ran.text ?? ''}` : 'stopped from the pane')
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
