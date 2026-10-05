import { describe, expect, mock, test, tier } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'
import type { On } from 'claude-code'

tier('user')

const SAVED = '/home/apexaipc/handoffs/my-proj/2026-10-04-1000-mods-auto-handoff.md'
const USAGE = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const DRAFT = [
  'PROJECT: picked-proj',
  'SLUG: mods-auto-handoff',
  '',
  '# Handoff: Auto-handoff mod built',
  'Date: 2026-10-04 10:00 CDT',
  '',
  '## Where we are',
  'Built it — tests pass.',
  '',
  '## What we decided',
  '- None',
  '',
  '## Next step',
  'Run it live.',
].join('\n')

const NOW = {
  command: 'auto-handoff',
  args: 'now',
  origin: { kind: 'composer' as const },
  presentation: { isFullscreen: false, columns: 80 },
}

const BAND_PROPS = {
  hasSurvey: false,
  isWorking: false,
  maxRows: 10,
  bodyColumns: 120,
  scroll: { offset: 0, bodyRows: 10 },
  view: {},
}

type World = {
  tokens: number | undefined
  window: number
  cwd: string
  forkText: string
}

function world(on: On, w: World) {
  const saves: string[][] = []
  const writes: { path: string; text: string }[] = []
  const prompts: string[] = []
  const toasts: string[] = []
  // Slash commands the mod ran, as typed; a test holds the fork to see "writing".
  const commands: string[] = []
  const gate: { hold: Promise<void> | null } = { hold: null }
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.env(on, { HOME: '/home/apexaipc' })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.usage', () => ({
    value: { startedAt: 0, context: { tokens: w.tokens, window: w.window }, rateLimits: [] },
  }))
  on('session.cwd', () => ({ value: w.cwd }))
  on('session.id', () => ({ value: 'abcdef1234567890' }))
  on('session.model', () => ({ value: 'claude-opus-5-5' }))
  on('model.fork', async ($, e) => {
    prompts.push(e.prompt)
    if (gate.hold) {
      await gate.hold
    }
    return { value: { isAnswered: true, text: w.forkText, usage: USAGE } }
  })
  on('fs.write', ($, e) => {
    writes.push({ path: e.path, text: e.text })
    return { value: undefined }
  })
  on('fs.read', () => ({ value: '' }))
  // The engine draws nothing of its own in the band; stand in for it when the
  // mod passes (no run yet, or dismissed).
  on('ui.render', { component: 'AbovePrompt' }, () => Fragment({}))
  on('command.run', ($, e) => {
    commands.push(`/${e.command} ${e.args}`.trim())
    return { text: '' }
  })
  on('ui.toast', ($, e) => {
    toasts.push(e.text)
    return { value: undefined }
  })
  on('process.run', ($, e) => {
    const [cmd, , sub] = e.argv
    const ok = (stdout: string) => ({ value: { exitCode: 0, stdout, stderr: '', isStdoutTruncated: false, isStderrTruncated: false } })
    const bad = (stderr: string) => ({ value: { exitCode: 1, stdout: '', stderr, isStdoutTruncated: false, isStderrTruncated: false } })
    if (cmd === 'date') return ok('2026-10-04 10:00 CDT\n')
    if (cmd === 'git') return ok('')
    if (sub === 'project') return w.cwd === '/home/apexaipc' ? bad('handoff: working directory is the home folder') : ok('my-proj\n')
    if (sub === 'list') return ok('aiva\t2026-09-08-2354-aiva-tiger-team.md\npicked-proj\t2026-10-01-0000-x.md\n')
    if (sub === 'latest') return bad('no handoffs')
    if (sub === 'save') {
      saves.push([...e.argv])
      return ok(`${SAVED}\n`)
    }
    return bad(`unexpected ${e.argv.join(' ')}`)
  })
  return { clock, saves, writes, prompts, toasts, commands, gate }
}

async function turn($: Parameters<TestBody>[0], agentId?: string) {
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 't', reason: 'answer', agentId })
}

function arg(argv: string[], flag: string): string | undefined {
  return argv[argv.indexOf(flag) + 1]
}

describe('register', () => {
  test('fires once at 300k of 1M, re-arms only after dropping below', async ($, on) => {
    const w: World = { tokens: 250_000, window: 1_000_000, cwd: '/work/my-proj', forkText: DRAFT }
    const t = world(on, w)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: w.cwd })

    await turn($)
    await t.clock.advance(5)
    expect(t.prompts.length).toBe(0)

    w.tokens = 300_000
    await turn($)
    await t.clock.advance(5)
    expect(t.saves.length).toBe(1)
    expect(arg(t.saves[0]!, '--project')).toBe('my-proj')
    expect(arg(t.saves[0]!, '--key')).toBe('auto-abcdef12-1')
    expect(arg(t.saves[0]!, '--slug')).toBe('mods-auto-handoff')
    expect(t.writes[0]!.text).toContain('Attempt-Key: auto-abcdef12-1')
    expect(t.writes[0]!.text).not.toContain('—')
    expect(t.toasts.at(-1)).toContain('/prime my-proj')

    w.tokens = 420_000
    await turn($)
    await t.clock.advance(5)
    expect(t.saves.length).toBe(1)

    w.tokens = 90_000
    await turn($)
    w.tokens = 310_000
    await turn($)
    await t.clock.advance(5)
    expect(t.saves.length).toBe(2)
    expect(arg(t.saves[1]!, '--key')).toBe('auto-abcdef12-2')
  })

  test('a window other than 1M never fires, nor does a subagent turn', async ($, on) => {
    const w: World = { tokens: 400_000, window: 500_000, cwd: '/work/my-proj', forkText: DRAFT }
    const t = world(on, w)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: w.cwd })
    await turn($)
    await t.clock.advance(5)
    expect(t.prompts.length).toBe(0)

    w.window = 1_000_000
    await turn($, 'agent-1')
    await t.clock.advance(5)
    expect(t.prompts.length).toBe(0)
  })

  test('in the home folder the fork picks the project from the handoff list', async ($, on) => {
    const w: World = { tokens: 300_000, window: 1_000_000, cwd: '/home/apexaipc', forkText: DRAFT }
    const t = world(on, w)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: w.cwd })
    await turn($)
    await t.clock.advance(5)
    expect(t.prompts[0]).toContain('picked-proj\t2026-10-01-0000-x.md')
    expect(arg(t.saves[0]!, '--project')).toBe('picked-proj')
  })

  test('"now" refuses before the first response, and writes once there is one', async ($, on) => {
    const w: World = { tokens: undefined, window: 1_000_000, cwd: '/work/my-proj', forkText: DRAFT }
    const t = world(on, w)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: w.cwd })

    const refused = await $.command.run(NOW)
    await t.clock.advance(5)
    expect(refused.text).toContain('Nothing to hand off yet')
    expect(t.prompts.length).toBe(0)

    w.tokens = 40_000
    const started = await $.command.run(NOW)
    await t.clock.advance(5)
    expect(started.text).toContain('Writing a handoff now')
    expect(t.saves.length).toBe(1)
  })

  test('a malformed draft is reported and never saved', async ($, on) => {
    const w: World = { tokens: 300_000, window: 1_000_000, cwd: '/work/my-proj', forkText: 'Sure! Here is a summary.' }
    const t = world(on, w)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: w.cwd })
    await turn($)
    await t.clock.advance(5)
    expect(t.saves.length).toBe(0)
    expect(t.toasts.at(-1)).toContain('Auto-handoff failed')
  })

  for (const surface of ['terminal', 'desktop'] as const) {
    test(`the band offers clear-and-prime only once the handoff is saved, and it runs both (${surface})`, async ($, on) => {
      const w: World = { tokens: 300_000, window: 1_000_000, cwd: '/work/my-proj', forkText: DRAFT }
      const t = world(on, w)
      let release = () => {}
      t.gate.hold = new Promise<void>(resolve => {
        release = resolve
      })
      await $.session.start({ surface, isInteractive: true, cwd: w.cwd })

      await turn($)
      await t.clock.advance(5)
      const ui = await $.ui.mount({ plugin: 'auto-handoff', surface, component: 'AbovePrompt', props: BAND_PROPS })
      expect(JSON.stringify(await ui.findAll({}))).toContain('Writing auto-handoff')
      expect(await ui.find({ key: 'pickup' })).toBeUndefined()

      release()
      await t.clock.advance(5)
      expect(t.saves.length).toBe(1)
      expect(await ui.find({ key: 'pickup' })).toBeDefined()
      expect(t.commands).toEqual([])

      await ui.press({ key: 'pickup' })
      expect(t.commands).toEqual(['/clear', '/prime my-proj'])
      expect(await ui.find({ key: 'pickup' })).toBeUndefined()
    })
  }

  test('a failed handoff draws no clear-and-prime button', async ($, on) => {
    const w: World = { tokens: 300_000, window: 1_000_000, cwd: '/work/my-proj', forkText: 'Sure! Here is a summary.' }
    const t = world(on, w)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: w.cwd })
    await turn($)
    await t.clock.advance(5)

    const ui = await $.ui.mount({ plugin: 'auto-handoff', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
    expect(JSON.stringify(await ui.findAll({}))).toContain('Auto-handoff failed')
    expect(await ui.find({ key: 'dismiss' })).toBeDefined()
    expect(await ui.find({ key: 'pickup' })).toBeUndefined()
    expect(t.commands).toEqual([])
  })
})
