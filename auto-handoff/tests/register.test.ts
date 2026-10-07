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
  // The desktop app's answer to archive_session; absent, it archives.
  archiveError?: string
  // What `handoff.mjs cutoff` prints; null, it fails (no transcript). Absent, CUTOFF.
  cutoff?: string | null
}

const CUTOFF = '5d6fe2e0-4e96-4002-b681-c1aec6d962a7 2026-10-04T15:00:01.903Z'

function world(on: On, w: World) {
  const saves: string[][] = []
  const writes: { path: string; text: string }[] = []
  const prompts: string[] = []
  const toasts: string[] = []
  // Slash commands the mod ran, as typed; a test holds the fork to see "writing".
  const commands: string[] = []
  const gate: { hold: Promise<void> | null } = { hold: null }
  // Tool calls that got past the mod to the world, by tool name.
  const ran: string[] = []
  // Desktop session tools the mod called, as "tool title-or-session".
  const sessions: string[] = []
  const copies: string[] = []
  // The cutoff read and the fork, in the order they happened.
  const order: string[] = []
  const cutoffs: string[][] = []
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
    order.push('fork')
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
  on('tool.call', ($, e) => {
    ran.push(e.tool)
    return { result: 'ran' }
  })
  on('mcp.call', ($, e) => {
    sessions.push(`${e.server} ${e.tool} ${String(e.args.title ?? e.args.session_id)}`)
    const failed = e.tool === 'archive_session' && w.archiveError !== undefined
    return { value: { content: [{ type: 'text', text: failed ? w.archiveError! : 'ok' }], isError: failed } }
  })
  on('ui.copy', ($, e) => {
    copies.push(e.text)
    return { value: { isCopied: true } }
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
    if (sub === 'cutoff') {
      order.push('cutoff')
      cutoffs.push([...e.argv])
      const c = w.cutoff === undefined ? CUTOFF : w.cutoff
      return c === null ? bad('handoff: no transcript for session abcdef1234567890') : ok(`${c}\n`)
    }
    if (sub === 'save') {
      saves.push([...e.argv])
      return ok(`${SAVED}\n`)
    }
    return bad(`unexpected ${e.argv.join(' ')}`)
  })
  return { clock, saves, writes, prompts, toasts, commands, gate, ran, sessions, copies, order, cutoffs }
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

  test('the Transcript-Cutoff is read before the fork starts and stamped by save', async ($, on) => {
    const w: World = { tokens: 300_000, window: 1_000_000, cwd: '/work/my-proj', forkText: DRAFT }
    const t = world(on, w)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: w.cwd })
    await turn($)
    await t.clock.advance(5)
    // Read first: what the session says while the fork drafts lands after it, in the tail.
    expect(t.order).toEqual(['cutoff', 'fork'])
    expect(t.cutoffs[0]).toEqual([
      'node', '/home/apexaipc/.claude/skills/next/scripts/handoff.mjs', 'cutoff',
      '--session', 'abcdef1234567890', '--cwd', '/work/my-proj', '--fork',
    ])
    expect(arg(t.saves[0]!, '--cutoff')).toBe(CUTOFF)
    // The fork is never asked for the stamp, so it cannot get it wrong.
    expect(t.prompts[0]).not.toContain('Transcript-Cutoff')
  })

  test('an unreadable transcript still saves, stamped none so /prime falls back to Date', async ($, on) => {
    const w: World = { tokens: 300_000, window: 1_000_000, cwd: '/work/my-proj', forkText: DRAFT, cutoff: null }
    const t = world(on, w)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: w.cwd })
    await turn($)
    await t.clock.advance(5)
    expect(t.saves.length).toBe(1)
    expect(arg(t.saves[0]!, '--cutoff')).toBe('none')
    expect(t.toasts.at(-1)).toContain('Handoff saved')
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

describe('retire toggle', () => {
  async function saved($: Parameters<TestBody>[0], on: On, surface: 'terminal' | 'desktop', archiveError?: string) {
    const w: World = { tokens: 300_000, window: 1_000_000, cwd: '/work/my-proj', forkText: DRAFT, archiveError }
    const t = world(on, w)
    await $.session.start({ surface, isInteractive: true, cwd: w.cwd })
    await turn($)
    await t.clock.advance(5)
    const ui = await $.ui.mount({ plugin: 'auto-handoff', surface, component: 'AbovePrompt', props: BAND_PROPS })
    return { t, ui }
  }

  test('the terminal draws no retire toggle: there is no sidebar session to archive', async ($, on) => {
    const { ui } = await saved($, on, 'terminal')
    expect(await ui.find({ key: 'pickup' })).toBeDefined()
    expect(await ui.find({ key: 'retire' })).toBeUndefined()
  })

  test('unchecked, the desktop pickup still clears and primes, touching no session tool', async ($, on) => {
    const { t, ui } = await saved($, on, 'desktop')
    expect(JSON.stringify(await ui.find({ key: 'retire' }))).toContain('[ ] Retire this session')
    await ui.press({ key: 'pickup' })
    expect(t.commands).toEqual(['/clear', '/prime my-proj'])
    expect(t.sessions).toEqual([])
  })

  test('checked, the pickup renames, copies /prime and archives instead of clearing', async ($, on) => {
    const { t, ui } = await saved($, on, 'desktop')
    await ui.press({ key: 'retire' })
    expect(JSON.stringify(await ui.find({ key: 'retire' }))).toContain('[x] Retire this session')
    expect(JSON.stringify(await ui.find({ key: 'pickup' }))).toContain('Retire session')

    await ui.press({ key: 'pickup' })
    expect(t.sessions).toEqual([
      'ccd_session_mgmt set_session_title ⛔ HANDED OFF: /prime my-proj',
      'ccd_session_mgmt archive_session self',
    ])
    expect(t.copies).toEqual(['/prime my-proj'])
    expect(t.commands).toEqual([])
    expect(t.toasts.at(-1)).toContain('Session retired')
  })

  test('a declined archive keeps the rename and says how to finish by hand', async ($, on) => {
    const { t, ui } = await saved($, on, 'desktop', 'The user declined')
    await ui.press({ key: 'retire' })
    await ui.press({ key: 'pickup' })
    expect(t.sessions.length).toBe(2)
    expect(t.toasts.at(-1)).toContain('Renamed; archive did not happen (The user declined)')
    expect(t.toasts.at(-1)).toContain('/prime my-proj in a new session')
    // The band stays, so the toggle can be unchecked and Clear and /prime used instead.
    expect(await ui.find({ key: 'pickup' })).toBeDefined()
  })
})

// A main-loop tool call as the model makes it; agentId marks a subagent's.
async function bash($: Parameters<TestBody>[0], agentId?: string) {
  return $.tool.call({ tool: 'Bash', command: 'ls', tool_use_id: 'tu', ...(agentId ? { agentId } : {}) })
}

const UNBLOCK = { ...NOW, args: 'unblock' }

describe('tool-call block', () => {
  test('a saved threshold handoff blocks main-loop tool calls, with the path and the way out', async ($, on) => {
    const w: World = { tokens: 300_000, window: 1_000_000, cwd: '/work/my-proj', forkText: DRAFT }
    const t = world(on, w)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: w.cwd })
    expect((await bash($)).deny).toBeUndefined()

    await turn($)
    await t.clock.advance(5)
    expect(t.saves.length).toBe(1)
    const denied = await bash($)
    expect(denied.deny).toContain(SAVED)
    expect(denied.deny).toContain('300k')
    expect(denied.deny).toContain('/prime my-proj')
    expect(denied.deny).toContain('/auto-handoff unblock')
    expect(t.ran).toEqual(['Bash'])

    const ui = await $.ui.mount({ plugin: 'auto-handoff', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
    expect(JSON.stringify(await ui.findAll({}))).toContain('tool calls are blocked')
    // Dismiss is withheld while blocked: the band is where the reason shows.
    expect(await ui.find({ key: 'dismiss' })).toBeUndefined()
    expect((await $.command.run({ ...NOW, args: '' })).text).toContain('Tool calls: BLOCKED')
  })

  test('no block while the handoff is still being written', async ($, on) => {
    const w: World = { tokens: 300_000, window: 1_000_000, cwd: '/work/my-proj', forkText: DRAFT }
    const t = world(on, w)
    let release = () => {}
    t.gate.hold = new Promise<void>(resolve => {
      release = resolve
    })
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: w.cwd })
    await turn($)
    await t.clock.advance(5)
    expect(t.prompts.length).toBe(1)
    expect((await bash($)).deny).toBeUndefined()

    release()
    await t.clock.advance(5)
    expect((await bash($)).deny).toBeDefined()
  })

  test('a failed write never blocks; the failure band stands', async ($, on) => {
    const w: World = { tokens: 300_000, window: 1_000_000, cwd: '/work/my-proj', forkText: 'Sure! Here is a summary.' }
    const t = world(on, w)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: w.cwd })
    await turn($)
    await t.clock.advance(5)
    expect(t.toasts.at(-1)).toContain('Auto-handoff failed')
    expect((await bash($)).deny).toBeUndefined()
    expect(t.ran).toEqual(['Bash'])
  })

  test('subagent calls and the wrap-up tools pass a block', async ($, on) => {
    const w: World = { tokens: 300_000, window: 1_000_000, cwd: '/work/my-proj', forkText: DRAFT }
    const t = world(on, w)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: w.cwd })
    await turn($)
    await t.clock.advance(5)
    expect((await bash($)).deny).toBeDefined()

    expect((await bash($, 'agent-1')).deny).toBeUndefined()
    const stop = await $.tool.call({ tool: 'TaskStop', task_id: 'agent-1', tool_use_id: 'ts' })
    expect(stop.deny).toBeUndefined()
    const read = await $.tool.call({ tool: 'Read', file_path: '/etc/hosts', tool_use_id: 'tr' })
    expect(read.deny).toBeDefined()
    expect(t.ran).toEqual(['Bash', 'TaskStop'])
  })

  test('/auto-handoff unblock lifts it for the rest of the window, even past a later turn', async ($, on) => {
    const w: World = { tokens: 300_000, window: 1_000_000, cwd: '/work/my-proj', forkText: DRAFT }
    const t = world(on, w)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: w.cwd })
    await turn($)
    await t.clock.advance(5)
    expect((await bash($)).deny).toBeDefined()

    expect((await $.command.run(UNBLOCK)).text).toContain('unblocked')
    expect((await bash($)).deny).toBeUndefined()
    w.tokens = 450_000
    await turn($)
    await t.clock.advance(5)
    expect((await bash($)).deny).toBeUndefined()
    expect(t.saves.length).toBe(1)
    const ui = await $.ui.mount({ plugin: 'auto-handoff', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
    expect(JSON.stringify(await ui.findAll({}))).not.toContain('tool calls are blocked')
  })

  test('an unblock sent while the handoff is being written keeps the save from blocking', async ($, on) => {
    const w: World = { tokens: 300_000, window: 1_000_000, cwd: '/work/my-proj', forkText: DRAFT }
    const t = world(on, w)
    let release = () => {}
    t.gate.hold = new Promise<void>(resolve => {
      release = resolve
    })
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: w.cwd })
    await turn($)
    await t.clock.advance(5)
    expect((await $.command.run(UNBLOCK)).text).toContain('were not blocked')
    release()
    await t.clock.advance(5)
    expect(t.saves.length).toBe(1)
    expect((await bash($)).deny).toBeUndefined()
  })

  test('dropping below re-arms: the next crossing blocks again, and an earlier unblock does not carry', async ($, on) => {
    const w: World = { tokens: 300_000, window: 1_000_000, cwd: '/work/my-proj', forkText: DRAFT }
    const t = world(on, w)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: w.cwd })
    await turn($)
    await t.clock.advance(5)
    await $.command.run(UNBLOCK)

    w.tokens = 60_000
    await turn($)
    expect((await bash($)).deny).toBeUndefined()
    w.tokens = 320_000
    await turn($)
    await t.clock.advance(5)
    expect(t.saves.length).toBe(2)
    expect((await bash($)).deny).toContain('320k')
  })

  test('a /clear between turns re-arms at the first tool call, so /prime can work', async ($, on) => {
    const w: World = { tokens: 300_000, window: 1_000_000, cwd: '/work/my-proj', forkText: DRAFT }
    const t = world(on, w)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: w.cwd })
    await turn($)
    await t.clock.advance(5)
    expect((await bash($)).deny).toBeDefined()

    // /clear typed by hand: no turn ends, the window just empties.
    w.tokens = undefined
    expect((await bash($)).deny).toBeUndefined()
    w.tokens = 310_000
    expect((await bash($)).deny).toBeUndefined()
  })

  test('the Clear and /prime button lifts the block before /prime runs', async ($, on) => {
    const w: World = { tokens: 300_000, window: 1_000_000, cwd: '/work/my-proj', forkText: DRAFT }
    const t = world(on, w)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: w.cwd })
    await turn($)
    await t.clock.advance(5)
    const ui = await $.ui.mount({ plugin: 'auto-handoff', surface: 'terminal', component: 'AbovePrompt', props: BAND_PROPS })
    await ui.press({ key: 'pickup' })
    expect(t.commands).toEqual(['/clear', '/prime my-proj'])
    expect((await bash($)).deny).toBeUndefined()
  })

  test('"/auto-handoff now" saves a handoff but never blocks, even past the threshold', async ($, on) => {
    const w: World = { tokens: 350_000, window: 1_000_000, cwd: '/work/my-proj', forkText: 'Sure! Here is a summary.' }
    const t = world(on, w)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: w.cwd })
    await turn($)
    await t.clock.advance(5)
    expect(t.toasts.at(-1)).toContain('Auto-handoff failed')

    w.forkText = DRAFT
    await $.command.run(NOW)
    await t.clock.advance(5)
    expect(t.saves.length).toBe(1)
    expect((await bash($)).deny).toBeUndefined()
  })

  test('a later handoff being written suspends the block until it saves', async ($, on) => {
    const w: World = { tokens: 300_000, window: 1_000_000, cwd: '/work/my-proj', forkText: DRAFT }
    const t = world(on, w)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: w.cwd })
    await turn($)
    await t.clock.advance(5)
    expect((await bash($)).deny).toBeDefined()

    let release = () => {}
    t.gate.hold = new Promise<void>(resolve => {
      release = resolve
    })
    await $.command.run(NOW)
    await t.clock.advance(5)
    expect((await bash($)).deny).toBeUndefined()
    release()
    await t.clock.advance(5)
    expect(t.saves.length).toBe(2)
    expect((await bash($)).deny).toBeDefined()
  })
})
