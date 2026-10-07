import { describe, expect, test, tier } from 'claude-code/testing'
import type { On } from 'claude-code'

tier('user')

const USAGE = { input_tokens: 0, output_tokens: 0, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 }
const LONG = 'A full answer, long enough to clear the eighty character minimum for offering next prompts.'

// The fork runs detached from turn.complete: let its awaits drain.
async function settle(): Promise<void> {
  for (let i = 0; i < 200; i++) await Promise.resolve()
}

// The world beneath the mod: the fork it asks and the ghost text it offers.
function world(on: On) {
  const forks: string[] = []
  const suggests: string[] = []
  on('session.start', ($, e) => ({ cwd: e.cwd }))
  on('turn.complete', ($, e) => ({ text: e.answer }))
  on('command.list', () => ({ value: [] }))
  on('model.fork', ($, e) => {
    forks.push(e.prompt)
    return { value: { isAnswered: true, text: '[{"label":"run tests","prompt":"run the tests"}]', usage: USAGE } }
  })
  on('prompt.suggest', ($, e) => {
    suggests.push(e.text)
    return { isShown: true }
  })
  return { forks, suggests }
}

describe('turn.complete', () => {
  test("the main loop's answer forks once and offers the top suggestion", async ($, on) => {
    const w = world(on)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
    await $.turn.complete({ answer: LONG, durationMs: 1, isAborted: false, reason: 'answer', turnId: 'main-1' })
    await settle()
    expect(w.forks.length).toBe(1)
    expect(w.suggests).toEqual(['run the tests'])
  })

  test("a subagent's answer does not fork or replace the suggestions", async ($, on) => {
    const w = world(on)
    await $.session.start({ surface: 'terminal', isInteractive: true, cwd: '/work' })
    await $.turn.complete({ answer: LONG, durationMs: 1, isAborted: false, reason: 'answer', turnId: 'main-1' })
    await settle()
    await $.turn.complete({
      answer: LONG,
      durationMs: 1,
      isAborted: false,
      reason: 'answer',
      turnId: 'sub-1',
      agentId: 'agent-9',
    })
    await settle()
    expect(w.forks.length).toBe(1)
    expect(w.suggests).toEqual(['run the tests'])
  })
})
