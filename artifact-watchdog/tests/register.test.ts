import { describe, expect, mock, test, tier } from 'claude-code/testing'
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
function world(on: On, file: { size: number; text: string }, isForeground = false) {
  const toasts: string[] = []
  const statuses: (string | undefined)[] = []
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.env(on, { HOME: '/home/apexaipc' })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('fs.stat', () => ({ value: { kind: 'file', size: file.size, mtimeMs: 0, isLink: false } }))
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
  const gate: { hold: Promise<void> | null } = { hold: null }
  on('tool.call', { tool: 'TaskStop' }, async ($, e) => {
    stops.push({ task_id: (e as { task_id?: unknown }).task_id, consent: (e as { consent?: unknown }).consent })
    if (gate.hold) {
      await gate.hold
    }
    return { result: { message: 'stopped' } }
  })
  return { clock, toasts, statuses, stops, gate, agent, opens }
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
    expect(JSON.stringify(await ui.findAll({}))).toContain('probe done (stalled earlier)')
  })
})
