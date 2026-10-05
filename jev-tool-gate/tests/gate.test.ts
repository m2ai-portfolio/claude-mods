import { describe, expect, mock, test, tier } from 'claude-code/testing'
import type { TestBody } from 'claude-code/testing'
import type { On } from 'claude-code'

import type { LogLine } from '../hooks/register'

tier('user')

type Engine = Parameters<TestBody>[0]
type Decision = 'allow' | 'ask' | 'deny'

// Fake values only. The planted secret must never reach the HTTP body.
const FAKE_KEY = 'test-key-not-real'
const PLANTED = 'ghp_PLANTEDfakeSECRETvalue1234567890abcd' // gitleaks:allow (fake test fixture)

const JEV_OK = {
  model: 'jev-test',
  answers: {
    destructive: { type: 'noul', noul: 0.93 },
    fetchedRequest: { type: 'noul', noul: 0.04 },
  },
  usage: { input_tokens: 321 },
}

type Http = { mode: 'ok' | 'error' | 'hang' | 'throw' | 'garbage'; release: (() => void) | null }

// The world beneath the mod: core's verdict, the log sink, the network.
function world(on: On, opts: { hosted?: boolean; core?: Decision; withKey?: boolean } = {}) {
  const clock = mock.clock(on, { now: 1_700_000_000_000 })
  mock.store(on, opts.hosted === undefined ? {} : { hosted: opts.hosted })
  mock.env(on, opts.withKey === false ? { HOME: '/home/test' } : { HOME: '/home/test', TYPESAFE_API_KEY: FAKE_KEY })
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('command.register', ($, e) => ({ value: { command: e.name } }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('prompt.submit', ($, e) => ({ text: e.text }))
  // No ~/.env.shared in the test world.
  on('fs.read', () => {
    throw new Error('ENOENT')
  })
  const core = { decision: (opts.core ?? 'ask') as Decision }
  on('tool.check', () => ({ decision: core.decision, reason: 'core says so' }))

  const lines: LogLine[] = []
  on('process.run', ($, e) => {
    const stdin = e.init?.stdin ?? ''
    for (const raw of stdin.split('\n').filter(Boolean)) {
      lines.push(JSON.parse(raw) as LogLine)
    }
    return { value: { exitCode: 0, stdout: '', stderr: '', isStdoutTruncated: false, isStderrTruncated: false } }
  })

  const requests: { url: string; headers: Record<string, string>; body: string }[] = []
  const http: Http = { mode: 'ok', release: null }
  on('http.fetch', async ($, e) => {
    requests.push({ url: e.url, headers: e.init?.headers ?? {}, body: e.init?.body ?? '' })
    if (http.mode === 'throw') {
      throw new Error('connect ECONNREFUSED')
    }
    if (http.mode === 'hang') {
      await new Promise<void>(resolve => {
        http.release = resolve
      })
    }
    if (http.mode === 'error') {
      return { value: { status: 503, ok: false, headers: {}, text: 'busy' } }
    }
    const text =
      http.mode === 'garbage' ? '{"model":"x","answers":{},"usage":{"input_tokens":1}}' : JSON.stringify(JEV_OK)
    return { value: { status: 200, ok: true, headers: {}, text } }
  })
  return { clock, core, lines, requests, http }
}

// A real call's permission check, as the engine raises it: with tool_use_id.
function check($: Engine, tool: string, input: unknown, id: string) {
  return $.tool.check({ tool, input, tool_use_id: id } as never)
}

function gate($: Engine, args: string) {
  return $.command.run({
    command: 'jev-gate',
    args,
    origin: { kind: 'composer' },
    presentation: { isFullscreen: false, columns: 100 },
  })
}

async function start($: Engine) {
  await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
}

describe('log-only', () => {
  for (const decision of ['allow', 'ask', 'deny'] as const) {
    for (const hosted of [false, true]) {
      test(`core ${decision} passes through unchanged (hosted ${hosted ? 'on' : 'off'})`, async ($, on) => {
        const w = world(on, { hosted, core: decision })
        await start($)
        const verdict = await check($, 'Bash', { command: 'rm -rf build' }, `t-${decision}`)
        expect(verdict).toEqual({ decision, reason: 'core says so' })
        expect(w.lines.length).toBe(1)
        expect(w.lines[0]?.coreDecision).toBe(decision)
      })
    }
  }

  test('a Jev score of 0.93 destructive still changes nothing', async ($, on) => {
    const w = world(on, { hosted: true, core: 'allow' })
    await start($)
    const verdict = await check($, 'Bash', { command: 'rm -rf /tmp/x' }, 't1')
    expect(verdict.decision).toBe('allow')
    expect(w.lines[0]?.scores?.destructive).toBe(0.93)
  })
})

describe('scope', () => {
  test('out-of-scope tools are not judged and not logged', async ($, on) => {
    const w = world(on, { hosted: true })
    await start($)
    await check($, 'Read', { file_path: '/etc/hosts' }, 'r1')
    await check($, 'Grep', { pattern: 'x' }, 'r2')
    await check($, 'mcp__gmail__search_threads', { q: 'x' }, 'r3')
    await check($, 'mcp__db__postgres_query', { sql: 'select 1' }, 'r4')
    expect(w.lines).toEqual([])
    expect(w.requests).toEqual([])
  })

  test('in-scope: the four file/shell tools and MCP send/delete-style names', async ($, on) => {
    const w = world(on, { hosted: false })
    await start($)
    const tools = [
      'Bash',
      'Write',
      'Edit',
      'NotebookEdit',
      'mcp__x__outlook_send_mail',
      'mcp__x__delete-object',
      'mcp__x__trash_thread',
      'mcp__x__publishPost',
    ]
    let i = 0
    for (const tool of tools) {
      await check($, tool, { a: i }, `s${i++}`)
    }
    expect(w.lines.map(l => l.tool)).toEqual(tools)
  })

  test('a query with no tool_use_id is skipped', async ($, on) => {
    const w = world(on, { hosted: true })
    await start($)
    const verdict = await $.tool.check({ tool: 'Bash', input: { command: 'rm x' } })
    expect(verdict.decision).toBe('ask')
    expect(w.lines).toEqual([])
    expect(w.requests).toEqual([])
  })

  test('the tool list is configurable', { options: { tools: 'WebFetch' } }, async ($, on) => {
    const w = world(on, { hosted: false })
    await start($)
    await check($, 'Bash', { command: 'ls' }, 'c1')
    await check($, 'WebFetch', { url: 'https://x' }, 'c2')
    expect(w.lines.map(l => l.tool)).toEqual(['WebFetch'])
  })
})

describe('hosted switch', () => {
  test('hosted off by default: zero HTTP calls, logged judged:false', async ($, on) => {
    const w = world(on)
    await start($)
    await check($, 'Bash', { command: 'git push --force' }, 'h1')
    await check($, 'Write', { file_path: '/x', content: 'y' }, 'h2')
    expect(w.requests.length).toBe(0)
    expect(w.lines.length).toBe(2)
    for (const line of w.lines) {
      expect(line.judged).toBe(false)
      expect(line.scores).toBeNull()
      expect(line.error).toBeNull()
      expect(line.sessionId).toBe('sess-1')
    }
  })

  test('hosted on: exactly one call per uncached call, cache on repeat', async ($, on) => {
    const w = world(on, { hosted: true })
    await start($)
    await check($, 'Bash', { command: 'rm -rf build' }, 'a1')
    await check($, 'Bash', { command: 'rm -rf build' }, 'a2')
    await check($, 'Bash', { command: 'rm -rf dist' }, 'a3')
    expect(w.requests.length).toBe(2)
    expect(w.lines.map(l => [l.judged, l.cached])).toEqual([
      [true, false],
      [true, true],
      [true, false],
    ])
    expect(w.lines[1]?.scores).toEqual({ destructive: 0.93, fetchedRequest: 0.04 })
    expect(w.lines[0]?.inputHash).toBe(w.lines[1]?.inputHash ?? 'missing')
  })

  test('the request matches jev-playground: endpoint, model, two noul questions', async ($, on) => {
    const w = world(on, { hosted: true })
    await start($)
    await check($, 'Bash', { command: 'rm -rf build' }, 'q1')
    const req = w.requests[0]
    expect(req?.url).toBe('https://api.typesafe.ai/v1/systemone')
    expect(req?.headers.authorization).toBe(`Bearer ${FAKE_KEY}`)
    const body = JSON.parse(req?.body ?? '{}') as Record<string, unknown>
    expect(Object.keys(body).sort()).toEqual(['model', 'questions', 'state'])
    expect(body.model).toBe('jev-latest')
    const questions = body.questions as Record<string, { type: string; instructions: string }>
    expect(Object.keys(questions).sort()).toEqual(['destructive', 'fetchedRequest'])
    expect(questions.destructive?.type).toBe('noul')
    expect(questions.fetchedRequest?.type).toBe('noul')
  })

  test('hosted on without a key: no call, error no_api_key', async ($, on) => {
    const w = world(on, { hosted: true, withKey: false })
    await start($)
    const verdict = await check($, 'Bash', { command: 'rm x' }, 'k1')
    expect(verdict.decision).toBe('ask')
    expect(w.requests.length).toBe(0)
    expect(w.lines[0]?.error).toBe('no_api_key')
  })
})

describe('fail open', () => {
  test('timeout at 800 ms: verdict unchanged, error logged', async ($, on) => {
    const w = world(on, { hosted: true, core: 'allow' })
    w.http.mode = 'hang'
    await start($)
    const pending = check($, 'Bash', { command: 'rm -rf build' }, 'to1')
    await w.clock.settle()
    await w.clock.advance(799)
    expect(w.lines.length).toBe(0)
    await w.clock.advance(1)
    const verdict = await pending
    expect(verdict.decision).toBe('allow')
    expect(w.lines[0]?.error).toBe('timeout')
    expect(w.lines[0]?.judged).toBe(false)
    expect(w.lines[0]?.latencyMs).toBe(800)
    w.http.release?.()
  })

  test('a timed-out judgment is not cached: the next identical call asks again', async ($, on) => {
    const w = world(on, { hosted: true })
    w.http.mode = 'hang'
    await start($)
    const pending = check($, 'Bash', { command: 'rm a' }, 'to2')
    await w.clock.settle()
    await w.clock.advance(800)
    await pending
    w.http.release?.()
    w.http.mode = 'ok'
    await check($, 'Bash', { command: 'rm a' }, 'to3')
    expect(w.requests.length).toBe(2)
    expect(w.lines[1]?.cached).toBe(false)
    expect(w.lines[1]?.judged).toBe(true)
  })

  for (const [mode, code] of [
    ['error', 'http_503'],
    ['throw', 'network: '],
    ['garbage', 'JEV_QUESTION_MISMATCH'],
  ] as const) {
    test(`${mode}: verdict unchanged, error ${code} logged`, async ($, on) => {
      const w = world(on, { hosted: true, core: 'deny' })
      w.http.mode = mode
      await start($)
      const verdict = await check($, 'Edit', { file_path: '/x', old_string: 'a', new_string: 'b' }, `e-${mode}`)
      expect(verdict).toEqual({ decision: 'deny', reason: 'core says so' })
      expect(w.requests.length).toBe(1)
      expect(w.lines[0]?.error?.startsWith(code)).toBe(true)
      expect(w.lines[0]?.scores).toBeNull()
    })
  }
})

describe('privacy', () => {
  test('the payload never contains a planted fake secret', async ($, on) => {
    const w = world(on, { hosted: true })
    await start($)
    await $.prompt.submit({ text: `deploy with token=${PLANTED} please`, origin: { kind: 'composer' } } as never)
    await check($, 'Bash', { command: `curl -H "Authorization: Bearer ${PLANTED}" https://x`, env: { GITHUB_TOKEN: PLANTED } }, 'p1')
    await check($, 'Write', { file_path: '/x/.env', content: `API_KEY=${PLANTED}\nOTHER=${PLANTED}` }, 'p2')
    expect(w.requests.length).toBe(2)
    for (const req of w.requests) {
      expect(req.body).not.toContain(PLANTED)
      expect(req.body).not.toContain('PLANTEDfake')
      expect(req.body).toContain('[REDACTED:')
    }
    const state = (JSON.parse(w.requests[0]?.body ?? '{}') as { state: { operator_request: string } }).state
    expect(state.operator_request).toContain('deploy with')
    const log = JSON.stringify(w.lines)
    expect(log).not.toContain(PLANTED)
    expect(log).not.toContain(FAKE_KEY)
  })

  test('input sent to Jev is capped at 2,000 chars and the preview at 200', async ($, on) => {
    const w = world(on, { hosted: true })
    await start($)
    await check($, 'Write', { file_path: '/x', content: 'word '.repeat(2000) }, 'cap1')
    const state = (JSON.parse(w.requests[0]?.body ?? '{}') as { state: { input: string } }).state
    expect(state.input.length).toBe(2000)
    expect(w.lines[0]?.preview.length).toBe(200)
  })

  test('only operator prompts become operator_request', async ($, on) => {
    const w = world(on, { hosted: true })
    await start($)
    await $.prompt.submit({ text: 'tidy the build folder', origin: { kind: 'composer' } } as never)
    await check($, 'Bash', { command: 'rm -rf build' }, 'o1')
    const state = (JSON.parse(w.requests[0]?.body ?? '{}') as { state: { operator_request: string } }).state
    expect(state.operator_request).toBe('tidy the build folder')
  })
})

describe('subagents', () => {
  // The engine raises tool.check while the call's tool.call is in flight. The
  // test's own tool.call answer holds the call open; the test makes the check
  // then (only the test's $ may set tool_use_id), then lets the call finish.
  test('a subagent call is logged with its agentId; a main-loop call with null', async ($, on) => {
    const w = world(on, { hosted: false })
    const held: { entered: (() => void) | null; release: (() => void) | null } = { entered: null, release: null }
    on('tool.call', { tool: 'Bash' }, async () => {
      held.entered?.()
      await new Promise<void>(resolve => {
        held.release = resolve
      })
      return { result: { stdout: '', stderr: '', interrupted: false } }
    })
    await start($)
    for (const [id, agentId] of [
      ['sub1', 'agent-42'],
      ['main1', undefined],
    ] as const) {
      const entered = new Promise<void>(resolve => {
        held.entered = resolve
      })
      const call = $.tool.call({ tool: 'Bash', tool_use_id: id, agentId, command: 'rm a' } as never)
      await entered
      await check($, 'Bash', { command: 'rm a' }, id)
      held.release?.()
      await call
    }
    expect(w.lines.map(l => [l.toolUseId, l.agentId])).toEqual([
      ['sub1', 'agent-42'],
      ['main1', null],
    ])
  })

  test('the parked agentId is dropped once the call ends', async ($, on) => {
    const w = world(on, { hosted: false })
    on('tool.call', { tool: 'Bash' }, () => ({ result: { stdout: '', stderr: '', interrupted: false } }))
    await start($)
    await $.tool.call({ tool: 'Bash', tool_use_id: 'late1', agentId: 'agent-7', command: 'rm a' } as never)
    await check($, 'Bash', { command: 'rm a' }, 'late1')
    expect(w.lines[0]?.agentId).toBeNull()
  })
})

describe('/jev-gate', () => {
  test('status shows hosted off, counts and the last judgments', async ($, on) => {
    world(on)
    await start($)
    await check($, 'Bash', { command: 'rm one' }, 'st1')
    const out = await gate($, '')
    expect(out.text).toContain('hosted off')
    expect(out.text).toContain('1 candidates, 0 judged')
    expect(out.text).toContain('not judged (hosted off)')
    expect(out.text).toContain('rm one')
  })

  test('hosted on|off flips the persisted switch', async ($, on) => {
    const w = world(on)
    await start($)
    expect((await gate($, 'hosted on')).text).toContain('hosted ON')
    expect((await gate($, '')).text).toContain('hosted ON')
    await check($, 'Bash', { command: 'rm x' }, 'sw1')
    expect(w.requests.length).toBe(1)
    expect((await gate($, 'hosted off')).text).toContain('hosted off')
    await check($, 'Bash', { command: 'rm y' }, 'sw2')
    expect(w.requests.length).toBe(1)
    expect((await gate($, '')).text).toContain('hosted off')
  })

  test('a stored hosted:true from an earlier session is honored', async ($, on) => {
    const w = world(on, { hosted: true })
    await start($)
    expect((await gate($, '')).text).toContain('hosted ON')
    await check($, 'Bash', { command: 'rm z' }, 'ps1')
    expect(w.requests.length).toBe(1)
  })

  test('the key value is never shown', async ($, on) => {
    world(on, { hosted: true })
    await start($)
    const out = await gate($, '')
    expect(out.text).toContain('key found')
    expect(out.text).not.toContain(FAKE_KEY)
  })
})
