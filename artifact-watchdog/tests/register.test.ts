import { describe, expect, mock, test, tier } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'
import type { On } from 'claude-code'

tier('user')

const ARTIFACT = '/home/apexaipc/.claude/agents/.artifacts/explore-probe.md'
const PANE_PROPS = {
  title: 'Artifact watchdog',
  isFocused: true,
  bodyColumns: 100,
  placement: 'dock' as const,
  scroll: { offset: 0, bodyRows: 20 },
  view: {},
}
const PROMPT = `Do the thing.\nOUTPUT CONTRACT: write to ${ARTIFACT}\nSCOPE: read-only.`

// The world beneath the mod: a file whose size and text the test sets.
function world(on: On, file: { size: number; text: string; mtimeMs?: number }, isForeground = false) {
  const toasts: string[] = []
  const statuses: (string | undefined)[] = []
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.env(on, { HOME: '/home/apexaipc' })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('fs.stat', () => ({ value: { kind: 'file', size: file.size, mtimeMs: file.mtimeMs ?? 0, isLink: false } }))
  on('fs.read', () => ({ value: file.text }))
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('ui.status', ($, e) => {
    statuses.push(e.text)
    return { value: undefined }
  })
  // No session.append hook: the kit (2.1.287) has no bottom for it and a test
  // hook must call next, so the mod's note to Claude is refused here. That
  // exercises the mod's "append refused" path; the note itself is checked live.
  on('tool.call', { tool: 'Agent' }, () => ({
    result: isForeground
      ? { status: 'completed', content: [] }
      : { status: 'async_launched', agentId: 'agent-7', description: 'probe' },
  }))
  // The engine's view of agent-7; a test flips it to model the hand-back.
  const agent = { status: 'running' }
  on('agent.list', () => ({
    value: [{ id: 'agent-7', description: 'probe', type: 'general-purpose', status: agent.status }],
  }))
  const opens: string[] = []
  on('ui.open', ($, e) => {
    opens.push(e.id)
    return { value: { isPlaced: true as const } }
  })
  const stops: { task_id: unknown; consent: unknown }[] = []
  // TaskStop answers at once unless a test holds it, as a permission ask does live.
  const gate: { hold: Promise<void> | null; answer: 'ok' | 'deny' | 'error' } = { hold: null, answer: 'ok' }
  on('tool.call', { tool: 'TaskStop' }, async ($, e) => {
    stops.push({ task_id: (e as { task_id?: unknown }).task_id, consent: (e as { consent?: unknown }).consent })
    if (gate.hold) {
      await gate.hold
    }
    if (gate.answer === 'deny') {
      return { deny: 'permission denied' }
    }
    if (gate.answer === 'error') {
      return { isError: true as const, result: null, text: 'no such task' }
    }
    return { result: { message: 'stopped' } }
  })
  // The wake: each $.prompt.submit the mod makes, and how the engine answers it.
  const submits: string[] = []
  const submit: { answer: 'enter' | 'drop' | 'throw' } = { answer: 'enter' }
  on('prompt.submit', ($, e) => {
    submits.push(e.text)
    if (submit.answer === 'throw') {
      throw new Error('submit exploded')
    }
    return submit.answer === 'drop' ? { drop: 'blocked by a test hook' } : { text: e.text }
  })
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  // A subagent's own tool calls and model requests; a test holds one open to
  // model a long test run or a long generation.
  const busy: { hold: Promise<void> | null } = { hold: null }
  on('tool.call', { tool: 'Bash' }, async () => {
    if (busy.hold) {
      await busy.hold
    }
    return { result: { stdout: '', stderr: '', interrupted: false } }
  })
  on('turn.step', async function* ($, e) {
    if (busy.hold) {
      await busy.hold
    }
    yield* []
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'end_turn' as const, usage: null }
  })
  return { clock, toasts, statuses, stops, gate, agent, opens, submits, submit, busy }
}

// The pane's whole drawing as text, for checking what a row says.
async function paneText($: Parameters<TestBody>[0]): Promise<string> {
  const ui = await $.ui.mount({
    plugin: 'artifact-watchdog',
    surface: 'desktop',
    component: 'Pane',
    requestId: 'artifact-watchdog',
    props: PANE_PROPS,
  })
  return JSON.stringify(await ui.findAll({}))
}

// One mounted pane, read as text as often as a test needs.
async function paneReader($: Parameters<TestBody>[0]): Promise<() => Promise<string>> {
  const ui = await $.ui.mount({
    plugin: 'artifact-watchdog',
    surface: 'desktop',
    component: 'Pane',
    requestId: 'artifact-watchdog',
    props: PANE_PROPS,
  })
  return async () => JSON.stringify(await ui.findAll({}))
}

// /watchdog as typed at the prompt: the engine stamps origin and presentation.
function watchdog($: Parameters<TestBody>[0], args: string) {
  return $.command.run({
    command: 'watchdog',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 100 },
  })
}

// Dispatch, let the artifact grow once, then sit still past the stall window.
async function dispatchAndStall($: Parameters<TestBody>[0], w: ReturnType<typeof world>, file: { size: number; text: string }) {
  await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })
  await $.tool.call({ tool: 'Agent', tool_use_id: 'tw', description: 'probe', prompt: PROMPT })
  file.size = 60
  file.text = '# Report\n'
  await w.clock.advance(15_000)
  await w.clock.advance(5 * 60_000 + 15_000)
}

describe('register', () => {
  test('an artifact that stops growing is flagged stalled after 5 minutes, once', async ($, on) => {
    const file = { size: 0, text: '' }
    const w = world(on, file)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
    await $.tool.call({ tool: 'Agent', tool_use_id: 't1', description: 'probe', prompt: PROMPT })

    file.size = 120
    file.text = '# Report\n## Section 1\n'
    await w.clock.advance(15_000)
    expect(w.toasts).toEqual([])

    await w.clock.advance(4 * 60_000)
    expect(w.toasts).toEqual([])

    await w.clock.advance(60_000)
    expect(w.toasts.length).toBe(1)
    expect(w.toasts[0]).toContain('probe')
    expect(w.statuses.at(-1)).toBe('artifacts: 1 STALLED')

    await w.clock.advance(5 * 60_000)
    expect(w.toasts.length).toBe(1)
  })

  test('a stall opens the pane once, so the Stop button is in view', async ($, on) => {
    const file = { size: 0, text: '' }
    const w = world(on, file)
    await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })
    await $.tool.call({ tool: 'Agent', tool_use_id: 't7', description: 'probe', prompt: PROMPT })
    expect(w.opens).toEqual([])

    await w.clock.advance(5 * 60_000 + 15_000)
    expect(w.opens).toEqual(['artifact-watchdog'])

    await w.clock.advance(10 * 60_000)
    expect(w.opens.length).toBe(1)
  })

  test('an async agent that hands back without the marker ends its watch and never stalls', async ($, on) => {
    const file = { size: 0, text: '' }
    const w = world(on, file)
    await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })
    await $.tool.call({ tool: 'Agent', tool_use_id: 't8', description: 'probe', prompt: PROMPT })
    file.size = 68
    file.text = '# Report\nheader only\n'
    await w.clock.advance(15_000)
    expect(w.statuses.at(-1)).toBe('artifacts: 1 running')

    w.agent.status = 'completed'
    await w.clock.advance(15_000)
    expect(w.statuses.at(-1)).toBeUndefined()

    await w.clock.advance(10 * 60_000)
    expect(w.toasts).toEqual([])
    expect(w.opens).toEqual([])

    const ui = await $.ui.mount({
      plugin: 'artifact-watchdog',
      surface: 'desktop',
      component: 'Pane',
      requestId: 'artifact-watchdog',
      props: PANE_PROPS,
    })
    expect(JSON.stringify(await ui.findAll({}))).toContain('agent completed without AGENT COMPLETE')
  })

  test('an agent whose last write is the marker reads complete, not ended', async ($, on) => {
    const file = { size: 0, text: '' }
    const w = world(on, file)
    await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })
    await $.tool.call({ tool: 'Agent', tool_use_id: 't9', description: 'probe', prompt: PROMPT })
    file.size = 90
    file.text = '# Report\nAGENT COMPLETE: probe done\n'
    w.agent.status = 'completed'
    await w.clock.advance(15_000)

    const ui = await $.ui.mount({
      plugin: 'artifact-watchdog',
      surface: 'desktop',
      component: 'Pane',
      requestId: 'artifact-watchdog',
      props: PANE_PROPS,
    })
    const tree = JSON.stringify(await ui.findAll({}))
    expect(tree).toContain('probe done')
    expect(tree).not.toContain('without AGENT COMPLETE')
  })

  test('a foreground agent that returns without the marker ends at once', async ($, on) => {
    const file = { size: 40, text: '# Report\n' }
    const w = world(on, file, true)
    await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })
    await $.tool.call({ tool: 'Agent', tool_use_id: 't10', description: 'probe', prompt: PROMPT })
    expect(w.statuses.at(-1)).toBeUndefined()

    await w.clock.advance(10 * 60_000)
    expect(w.toasts).toEqual([])
  })

  test('growth after a stall clears it, and the AGENT COMPLETE marker closes the watch', async ($, on) => {
    const file = { size: 0, text: '' }
    const w = world(on, file)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
    await $.tool.call({ tool: 'Agent', tool_use_id: 't2', description: 'probe', prompt: PROMPT })

    await w.clock.advance(5 * 60_000 + 15_000)
    expect(w.statuses.at(-1)).toBe('artifacts: 1 STALLED')

    file.size = 80
    file.text = '# Report\n'
    await w.clock.advance(15_000)
    expect(w.statuses.at(-1)).toBe('artifacts: 1 running')

    file.size = 200
    file.text = '# Report\nDone.\nAGENT COMPLETE: probe finished\n'
    await w.clock.advance(15_000)
    expect(w.statuses.at(-1)).toBeUndefined()

    await w.clock.advance(10 * 60_000)
    expect(w.toasts.length).toBe(1)
  })

  test('a dispatch with no artifact path is recorded as missing and never polled', async ($, on) => {
    const file = { size: 0, text: '' }
    const w = world(on, file)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
    await $.tool.call({ tool: 'Agent', tool_use_id: 't3', description: 'loose', prompt: 'no path here' })

    await w.clock.advance(20 * 60_000)
    expect(w.toasts).toEqual([])
    expect(w.statuses.at(-1)).toBeUndefined()
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    test(`pressing Stop on a stalled row calls TaskStop with consent and marks it stopped (${surface})`, async ($, on) => {
      const file = { size: 0, text: '' }
      const w = world(on, file)
      await $.session.start({ surface, isInteractive: true, cwd: '/work' })
      await $.tool.call({ tool: 'Agent', tool_use_id: 't4', description: 'probe', prompt: PROMPT })
      file.size = 60
      file.text = '# Report\n'
      await w.clock.advance(15_000)
      await w.clock.advance(5 * 60_000 + 15_000)
      expect(w.statuses.at(-1)).toBe('artifacts: 1 STALLED')

      const ui = await $.ui.mount({
        plugin: 'artifact-watchdog',
        surface,
        component: 'Pane',
        requestId: 'artifact-watchdog',
        props: PANE_PROPS,
      })
      expect(await ui.find({ key: 'stop-t4' })).toBeDefined()
      await ui.press({ key: 'stop-t4' })

      expect(w.stops.length).toBe(1)
      expect(w.stops[0]?.task_id).toBe('agent-7')
      expect(String(w.stops[0]?.consent)).toContain('pressed "Stop"')
      expect(w.statuses.at(-1)).toBeUndefined()
      expect(await ui.find({ key: 'stop-t4' })).toBeUndefined()
    })
  }

  test('a Stop held by an unanswered TaskStop shows stopping, then says so after 30s', async ($, on) => {
    const file = { size: 0, text: '' }
    const w = world(on, file)
    let release = () => {}
    w.gate.hold = new Promise<void>(resolve => {
      release = resolve
    })
    await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })
    await $.tool.call({ tool: 'Agent', tool_use_id: 't5', description: 'probe', prompt: PROMPT })
    file.size = 60
    file.text = '# Report\n'
    await w.clock.advance(15_000)
    await w.clock.advance(5 * 60_000 + 15_000)

    const ui = await $.ui.mount({
      plugin: 'artifact-watchdog',
      surface: 'desktop',
      component: 'Pane',
      requestId: 'artifact-watchdog',
      props: PANE_PROPS,
    })
    const pressing = ui.press({ key: 'stop-t5' })
    await w.clock.advance(1_000)
    expect(JSON.stringify(await ui.findAll({}))).toContain('waiting on TaskStop')
    await w.clock.advance(30_000)
    expect(JSON.stringify(await ui.findAll({}))).toContain('unanswered after 30s')

    release()
    await pressing
    expect(JSON.stringify(await ui.findAll({}))).toContain('stopped from the pane')
  })

  test('a row that stalled and then completed keeps the stall in its history', async ($, on) => {
    const file = { size: 0, text: '' }
    const w = world(on, file)
    await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })
    await $.tool.call({ tool: 'Agent', tool_use_id: 't6', description: 'probe', prompt: PROMPT })
    file.size = 60
    file.text = '# Report\n'
    await w.clock.advance(15_000)
    await w.clock.advance(5 * 60_000 + 15_000)
    file.size = 120
    file.text = '# Report\nAGENT COMPLETE: probe done\n'
    await w.clock.advance(15_000)

    const ui = await $.ui.mount({
      plugin: 'artifact-watchdog',
      surface: 'desktop',
      component: 'Pane',
      requestId: 'artifact-watchdog',
      props: PANE_PROPS,
    })
    expect(JSON.stringify(await ui.findAll({}))).toContain('probe done (stalled earlier) · woke Claude')
  })
})

describe('reused artifact path', () => {
  test("an earlier run's AGENT COMPLETE does not close a new dispatch's watch", async ($, on) => {
    const file = { size: 90, text: '# Old report\nAGENT COMPLETE: old run\n', mtimeMs: 100 }
    const w = world(on, file)
    await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })
    await $.tool.call({ tool: 'Agent', tool_use_id: 'tr', description: 'probe', prompt: PROMPT })
    const pane = await paneReader($)
    await w.clock.advance(15_000)
    await w.clock.advance(15_000)
    expect(await pane()).toContain('waiting')
    expect(await pane()).not.toContain('complete')

    // The new run overwrites the file (shorter), then finishes with its own marker.
    file.size = 20
    file.text = '# New report\n'
    file.mtimeMs = 200
    await w.clock.advance(15_000)
    expect(await pane()).toContain('growing')
    file.size = 60
    file.text = '# New report\nAGENT COMPLETE: new run\n'
    file.mtimeMs = 300
    await w.clock.advance(15_000)
    expect(await pane()).toContain('new run')
  })

  test('a same-size rewrite with a newer mtime counts as a write', async ($, on) => {
    const file = { size: 90, text: '# Old report\nAGENT COMPLETE: old run\n', mtimeMs: 100 }
    const w = world(on, file)
    await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })
    await $.tool.call({ tool: 'Agent', tool_use_id: 'ts', description: 'probe', prompt: PROMPT })
    await w.clock.advance(15_000)
    file.text = '# New report, padded to the same length..\nAGENT COMPLETE: same\n'
    file.mtimeMs = 500
    await w.clock.advance(15_000)
    expect(await paneText($)).toContain('same')
  })

  test('an unchanged old file stalls the new watch instead of completing it', async ($, on) => {
    const file = { size: 90, text: '# Old report\nAGENT COMPLETE: old run\n', mtimeMs: 100 }
    const w = world(on, file)
    await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })
    await $.tool.call({ tool: 'Agent', tool_use_id: 'tu', description: 'probe', prompt: PROMPT })
    await w.clock.advance(5 * 60_000 + 15_000)
    expect(w.toasts.length).toBe(1)
    expect(w.statuses.at(-1)).toBe('artifacts: 1 STALLED')
  })
})

describe('failed Stop', () => {
  for (const answer of ['deny', 'error'] as const) {
    test(`a TaskStop that comes back ${answer} keeps the row stalled, watched and stoppable`, async ($, on) => {
      const file = { size: 0, text: '' }
      const w = world(on, file)
      w.gate.answer = answer
      await dispatchAndStall($, w, file)
      const ui = await $.ui.mount({
        plugin: 'artifact-watchdog',
        surface: 'desktop',
        component: 'Pane',
        requestId: 'artifact-watchdog',
        props: PANE_PROPS,
      })
      await ui.press({ key: 'stop-tw' })
      expect(w.stops.length).toBe(1)
      expect(w.statuses.at(-1)).toBe('artifacts: 1 STALLED')
      expect(JSON.stringify(await ui.findAll({}))).toContain(answer === 'deny' ? 'Stop denied' : 'Stop failed')
      expect(w.toasts.some(t => t.includes('did not go through'))).toBe(true)
      expect(await ui.find({ key: 'stop-tw' })).toBeDefined()

      // Still polled: growth clears the stall.
      file.size = 120
      file.text = '# Report\nmore\n'
      await w.clock.advance(15_000)
      expect(JSON.stringify(await ui.findAll({}))).toContain('growing')

      // And a later Stop that works marks it stopped.
      w.gate.answer = 'ok'
      await w.clock.advance(5 * 60_000 + 15_000)
      await ui.press({ key: 'stop-tw' })
      expect(w.stops.length).toBe(2)
      expect(JSON.stringify(await ui.findAll({}))).toContain('stopped from the pane')
      expect(w.statuses.at(-1)).toBeUndefined()
    })
  }
})

describe('wake on stall', () => {
  test('/watchdog wake off during a turn cancels a wake already pending', async ($, on) => {
    const file = { size: 0, text: '' }
    const w = world(on, file)
    await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })
    const pane = await paneReader($)
    await $.turn.start({ text: 'work', turnId: 'turn-1' })
    await $.tool.call({ tool: 'Agent', tool_use_id: 'tw', description: 'probe', prompt: PROMPT })
    await w.clock.advance(5 * 60_000 + 15_000)
    expect(await pane()).toContain('wake pending until the turn ends')

    await watchdog($, 'wake off')
    expect(await pane()).not.toContain('wake pending')
    await $.turn.complete({ answer: 'done', durationMs: 1, isAborted: false, reason: 'answer', turnId: 'turn-1' })
    await w.clock.advance(5 * 60_000)
    expect(w.submits).toEqual([])
  })

  test('a stall with the main loop idle submits one wake naming the agent', async ($, on) => {
    const file = { size: 0, text: '' }
    const w = world(on, file)
    await dispatchAndStall($, w, file)

    expect(w.submits.length).toBe(1)
    expect(w.submits[0]).toContain('"probe" (agent-7)')
    expect(w.submits[0]).toContain(ARTIFACT)
    expect(w.submits[0]).toContain('TaskStop agent agent-7 and do the task inline')
    expect(w.toasts.length).toBe(1)
    expect(await paneText($)).toContain('woke Claude')
  })

  test('later ticks of the same stall do not wake again', async ($, on) => {
    const file = { size: 0, text: '' }
    const w = world(on, file)
    await dispatchAndStall($, w, file)
    expect(w.submits.length).toBe(1)

    await w.clock.advance(20 * 60_000)
    expect(w.submits.length).toBe(1)
  })

  test('growth after a stall, then a second stall, wakes once more', async ($, on) => {
    const file = { size: 0, text: '' }
    const w = world(on, file)
    await dispatchAndStall($, w, file)
    expect(w.submits.length).toBe(1)

    file.size = 140
    file.text = '# Report\n## Section 2\n'
    await w.clock.advance(15_000)
    expect(w.statuses.at(-1)).toBe('artifacts: 1 running')
    expect(w.submits.length).toBe(1)

    await w.clock.advance(5 * 60_000 + 15_000)
    expect(w.statuses.at(-1)).toBe('artifacts: 1 STALLED')
    expect(w.submits.length).toBe(2)
  })

  test('/watchdog wake off stops the wake but not the toast; wake on lets the next stall wake', async ($, on) => {
    const file = { size: 0, text: '' }
    const w = world(on, file)
    await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })
    const off = await watchdog($, 'wake off')
    expect(off.text).toContain('wake on stall is off')
    expect((await watchdog($, 'wake')).text).toContain('is off')
    expect(await paneText($)).toContain('wake off')

    await $.tool.call({ tool: 'Agent', tool_use_id: 'tw', description: 'probe', prompt: PROMPT })
    await w.clock.advance(5 * 60_000 + 15_000)
    expect(w.toasts.length).toBe(1)
    expect(w.submits).toEqual([])

    // Switched back on, the stall that landed while off stays unwoken; a new one wakes.
    await watchdog($, 'wake on')
    await w.clock.advance(5 * 60_000)
    expect(w.submits).toEqual([])
    file.size = 60
    file.text = '# Report\n'
    await w.clock.advance(15_000)
    await w.clock.advance(5 * 60_000 + 15_000)
    expect(w.submits.length).toBe(1)
  })

  test('/watchdog with other args answers usage and opens nothing', async ($, on) => {
    const file = { size: 0, text: '' }
    const w = world(on, file)
    await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })
    expect((await watchdog($, 'wake maybe')).text).toContain('Usage')
    expect(w.opens).toEqual([])
    expect((await watchdog($, '')).text).toContain('Wake on stall: on')
  })

  test('a watch that completed or ended never wakes', async ($, on) => {
    const file = { size: 0, text: '' }
    const w = world(on, file)
    await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })
    await $.tool.call({ tool: 'Agent', tool_use_id: 'tc', description: 'done', prompt: PROMPT })
    file.size = 90
    file.text = '# Report\nAGENT COMPLETE: done\n'
    await w.clock.advance(15_000)
    await w.clock.advance(10 * 60_000)
    expect(w.submits).toEqual([])

    // A second dispatch whose agent hands back without the marker: ended, not stalled.
    w.agent.status = 'completed'
    await $.tool.call({ tool: 'Agent', tool_use_id: 'te', description: 'quiet', prompt: PROMPT })
    await w.clock.advance(10 * 60_000)
    expect(w.submits).toEqual([])
    expect(w.toasts).toEqual([])
  })

  test('a stall mid-turn leaves the note and wakes when that turn ends with the agent still stuck', async ($, on) => {
    const file = { size: 0, text: '' }
    const w = world(on, file)
    await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })
    await $.turn.start({ text: 'work', turnId: 'turn-1' })
    await $.tool.call({ tool: 'Agent', tool_use_id: 'tw', description: 'probe', prompt: PROMPT })
    await w.clock.advance(5 * 60_000 + 15_000)
    expect(w.toasts.length).toBe(1)
    expect(w.submits).toEqual([])
    expect(await paneText($)).toContain('wake pending until the turn ends')

    await $.turn.complete({ answer: 'waiting on probe', durationMs: 1, isAborted: false, reason: 'answer', turnId: 'turn-1' })
    expect(w.submits.length).toBe(1)
    await w.clock.advance(5 * 60_000)
    expect(w.submits.length).toBe(1)
  })

  test('a stall mid-turn whose agent Claude stopped before the turn ended never wakes', async ($, on) => {
    const file = { size: 0, text: '' }
    const w = world(on, file)
    await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })
    await $.turn.start({ text: 'work', turnId: 'turn-1' })
    await $.tool.call({ tool: 'Agent', tool_use_id: 'tw', description: 'probe', prompt: PROMPT })
    await w.clock.advance(5 * 60_000 + 15_000)

    w.agent.status = 'killed'
    await $.turn.complete({ answer: 'stopped it', durationMs: 1, isAborted: false, reason: 'answer', turnId: 'turn-1' })
    await w.clock.advance(5 * 60_000)
    expect(w.submits).toEqual([])
  })

  test("a subagent's turn ending does not count as the main loop going idle", async ($, on) => {
    const file = { size: 0, text: '' }
    const w = world(on, file)
    await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })
    await $.turn.start({ text: 'work', turnId: 'turn-1' })
    await $.tool.call({ tool: 'Agent', tool_use_id: 'tw', description: 'probe', prompt: PROMPT })
    await w.clock.advance(5 * 60_000 + 15_000)

    await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, reason: 'answer', turnId: 'sub-1', agentId: 'agent-9' })
    await w.clock.advance(60_000)
    expect(w.submits).toEqual([])
  })

  // drop: a hook refuses the prompt. throw: the engine skips a hook that throws
  // and nothing beneath answers, so the mod's $.prompt.submit rejects.
  for (const answer of ['drop', 'throw'] as const) {
    test(`a wake the engine refuses (${answer}) is recorded on the row and nothing throws`, async ($, on) => {
      const file = { size: 0, text: '' }
      const w = world(on, file)
      w.submit.answer = answer
      await dispatchAndStall($, w, file)

      expect(w.submits.length).toBe(1)
      expect(w.toasts.length).toBe(1)
      expect(w.opens).toEqual(['artifact-watchdog'])
      expect(await paneText($)).toContain(
        answer === 'drop' ? 'wake failed: blocked by a test hook' : 'wake failed: no implementation for prompt.submit',
      )

      // The watch keeps working: later ticks neither retry nor fail.
      await w.clock.advance(10 * 60_000)
      expect(w.submits.length).toBe(1)
      expect(w.statuses.at(-1)).toBe('artifacts: 1 STALLED')
    })
  }
})

// One tool call in agent-7's own loop, run to its end.
async function agentCall($: Parameters<TestBody>[0], n: number) {
  await $.tool.call({ tool: 'Bash', command: 'npm test', tool_use_id: `b${n}`, agentId: 'agent-7' })
}

// Holds the world's next agent call open until the returned release runs.
function hold(w: ReturnType<typeof world>): () => void {
  let release = () => {}
  w.busy.hold = new Promise<void>(resolve => {
    release = () => {
      w.busy.hold = null
      resolve()
    }
  })
  return release
}

describe('agent activity', () => {
  test('a quiet file with an active agent shows quiet, never stalls or wakes', async ($, on) => {
    const file = { size: 0, text: '' }
    const w = world(on, file)
    await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })
    await $.tool.call({ tool: 'Agent', tool_use_id: 'ta', description: 'probe', prompt: PROMPT })
    file.size = 60
    file.text = '# Report\n'
    await w.clock.advance(15_000)

    // A call a minute for 12 minutes, the file never growing again.
    for (let n = 0; n < 12; n++) {
      await w.clock.advance(60_000)
      await agentCall($, n)
    }
    await w.clock.advance(15_000)
    expect(w.toasts).toEqual([])
    expect(w.submits).toEqual([])
    expect(w.opens).toEqual([])
    expect(w.statuses.at(-1)).toBe('artifacts: 1 running')
    const pane = await paneText($)
    expect(pane).toContain('quiet file, agent active')
    expect(pane).toContain('last activity 15s ago')
  })

  test('a quiet file with a silent agent stalls once both windows pass', async ($, on) => {
    const file = { size: 0, text: '' }
    const w = world(on, file)
    await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })
    await $.tool.call({ tool: 'Agent', tool_use_id: 'ts', description: 'probe', prompt: PROMPT })
    file.size = 60
    file.text = '# Report\n'
    await w.clock.advance(15_000)

    // Last sign of life at about 4.5 min: the file window passes at 5:15, but
    // the agent is not silent for 2 min until about 6:30.
    await w.clock.advance(4 * 60_000)
    await agentCall($, 1)
    await w.clock.advance(60_000)
    expect(w.toasts).toEqual([])
    expect(await paneText($)).toContain('quiet file, agent active')

    await w.clock.advance(75_000)
    expect(w.toasts.length).toBe(1)
    expect(w.statuses.at(-1)).toBe('artifacts: 1 STALLED')
    expect(w.submits.length).toBe(1)
  })

  test('a long tool call in flight counts as active until the 15 min cap', async ($, on) => {
    const file = { size: 0, text: '' }
    const w = world(on, file)
    await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })
    await $.tool.call({ tool: 'Agent', tool_use_id: 'tl', description: 'probe', prompt: PROMPT })
    file.size = 60
    file.text = '# Report\n'
    await w.clock.advance(15_000)

    const release = hold(w)
    const running = agentCall($, 1)
    await w.clock.advance(10 * 60_000)
    expect(w.toasts).toEqual([])
    expect(await paneText($)).toContain('Bash running 600s')

    // Past the cap the call is treated as hung: silent since it started.
    await w.clock.advance(5 * 60_000 + 15_000)
    expect(w.toasts.length).toBe(1)
    expect(w.statuses.at(-1)).toBe('artifacts: 1 STALLED')
    release()
    await running
  })

  test('a long model request in flight counts as active', async ($, on) => {
    const file = { size: 0, text: '' }
    const w = world(on, file)
    await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })
    await $.tool.call({ tool: 'Agent', tool_use_id: 'tm', description: 'probe', prompt: PROMPT })

    const release = hold(w)
    const streaming = (async () => {
      for await (const chunk of $.turn.step({ turnId: 'sub', index: 0, model: 'm', messageCount: 3, agentId: 'agent-7' })) {
        void chunk
      }
    })()
    await w.clock.advance(8 * 60_000)
    expect(w.toasts).toEqual([])
    expect(await paneText($)).toContain('model request running')
    release()
    await streaming

    await w.clock.advance(2 * 60_000 + 15_000)
    expect(w.toasts.length).toBe(1)
  })

  test('activity after a stall clears it; going silent again resumes the same stall without a second wake', async ($, on) => {
    const file = { size: 0, text: '' }
    const w = world(on, file)
    await dispatchAndStall($, w, file)
    expect(w.statuses.at(-1)).toBe('artifacts: 1 STALLED')
    expect(w.submits.length).toBe(1)

    await agentCall($, 1)
    await w.clock.advance(15_000)
    expect(w.statuses.at(-1)).toBe('artifacts: 1 running')
    expect(await paneText($)).toContain('quiet file, agent active')

    await w.clock.advance(2 * 60_000)
    expect(w.statuses.at(-1)).toBe('artifacts: 1 STALLED')
    expect(w.submits.length).toBe(1)
    expect(w.toasts.length).toBe(1)

    // Growth, then a fresh stall: that one earns its own wake.
    file.size = 140
    file.text = '# Report\n## More\n'
    await w.clock.advance(15_000)
    await w.clock.advance(5 * 60_000 + 15_000)
    expect(w.submits.length).toBe(2)
    expect(w.toasts.length).toBe(2)
  })

  test("another agent's activity does not keep a silent one alive", async ($, on) => {
    const file = { size: 0, text: '' }
    const w = world(on, file)
    await $.session.start({ surface: 'desktop', isInteractive: true, cwd: '/work' })
    await $.tool.call({ tool: 'Agent', tool_use_id: 'to', description: 'probe', prompt: PROMPT })
    for (let n = 0; n < 6; n++) {
      await w.clock.advance(60_000)
      await $.tool.call({ tool: 'Bash', command: 'ls', tool_use_id: `o${n}`, agentId: 'agent-other' })
    }
    await w.clock.advance(15_000)
    expect(w.toasts.length).toBe(1)
  })
})
