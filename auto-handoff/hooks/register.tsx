// Auto Handoff: runs /next for you before a long session gets heavy.
//
// turn.complete (main loop): read the context fill. In a 1,000,000-token
// window, the first reading at or past 300,000 tokens starts one handoff;
// dropping back below (a /clear, a compaction) re-arms it.
// The handoff: $.model.fork drafts it from the session's own transcript (a
// cached, tool-less question), in the exact /next format; handoff.mjs saves
// it, moves LATEST and appends DECISIONS.md, as /next's Step 4 does.
// ui.render (AbovePrompt): what happened and the pickup line (/clear, /prime);
// once saved, a button runs both.
// /auto-handoff: status; "/auto-handoff now" writes one immediately.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { HandoffRun } from '../types'

const WINDOW = 1_000_000
const THRESHOLD = 300_000

const isArmed = atom({ plugin: 'auto-handoff', key: 'isArmed' } as const, true)
const crossings = atom({ plugin: 'auto-handoff', key: 'crossings' } as const, 0)
const last = atom({ plugin: 'auto-handoff', key: 'last' } as const, null)
const isDismissed = atom({ plugin: 'auto-handoff', key: 'isDismissed' } as const, false)

let isWriting = false

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await $.command.register({
      name: 'auto-handoff',
      description: 'Auto-handoff status; "now" writes a /next handoff immediately',
    })
    return result
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId) {
      return result
    }
    const { context } = await $.session.usage()
    const tokens = context.tokens ?? 0
    if (context.window !== WINDOW) {
      return result
    }
    if (tokens < THRESHOLD) {
      await update($, isArmed, () => true)
      return result
    }
    const { value: armed = true } = await $.state.get({ plugin: 'auto-handoff', key: 'isArmed' } as const)
    if (armed && !isWriting) {
      await update($, isArmed, () => false)
      // Outside this dispatch: the fork must not die with the turn's hook.
      $.clock.after(1, () => {
        void writeHandoff($, tokens)
      })
    }
    return result
  })

  on('command.run', { command: 'auto-handoff' }, async ($, e) => {
    if (e.args.trim() === 'now') {
      if (isWriting) {
        return { text: 'An auto-handoff is already being written.' }
      }
      const { context } = await $.session.usage()
      // No tokens means no response yet in this window (a fresh chat, or
      // right after /clear or a compaction); the fork would only answer
      // nothing-to-fork, so refuse instead of starting a write that fails.
      if (context.tokens === undefined) {
        return { text: 'Nothing to hand off yet: send a message first, then run /auto-handoff now.' }
      }
      const { tokens } = context
      $.clock.after(1, () => {
        void writeHandoff($, tokens)
      })
      return { text: 'Writing a handoff now. The band above the prompt shows when it is saved.' }
    }
    const { context } = await $.session.usage()
    const { value: run } = await $.state.get({ plugin: 'auto-handoff', key: 'last' } as const)
    const tokens = context.tokens ?? 0
    const lines = [
      `Context: ${short(tokens)} of ${short(context.window)}.`,
      context.window === WINDOW
        ? `Auto-handoff fires at ${short(THRESHOLD)}.`
        : `Auto-handoff is off for this session: it applies only to a ${short(WINDOW)} window.`,
      run ? `Last: ${run.status}${run.path ? ` ${run.path}` : ''}${run.detail ? ` (${run.detail})` : ''}` : 'Last: none yet.',
    ]
    return { text: lines.join('\n') }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const run = await read($, last)
    if (e.props.hasSurvey || run === null || (await read($, isDismissed))) {
      return next(e)
    }
    const { Box, Text, Button } = $.ui.resolve(e)
    const dismiss = (
      <Button key="dismiss" label="Dismiss" plain onPress={() => update($, isDismissed, () => true)} />
    )
    if (run.status === 'writing') {
      return (
        <Box flexDirection="row" paddingX={1}>
          <Text color="yellow">… Writing auto-handoff at {short(run.tokens)} tokens</Text>
        </Box>
      )
    }
    if (run.status === 'failed') {
      return (
        <Box flexDirection="row" paddingX={1}>
          <Text color="red">✗ Auto-handoff failed: {run.detail}. Run /next yourself. </Text>
          {dismiss}
        </Box>
      )
    }
    return (
      <Box flexDirection="column" paddingX={1}>
        <Box flexDirection="row">
          <Text color="green" bold>
            ✓ Handoff saved at {short(run.tokens)} tokens{' '}
          </Text>
          <Text dimColor>{run.path} </Text>
          {dismiss}
        </Box>
        <Box flexDirection="row">
          <Text>To continue fresh: /clear, then /prime {run.project} </Text>
          <Button
            key="pickup"
            label={`Clear and /prime ${run.project}`}
            variant="primary"
            onPress={() => clearAndPrime($, run.project)}
          />
        </Box>
      </Box>
    )
  })
}

// The fork's instructions: /next Steps 2-3, with the facts a tool-less
// completion cannot look up handed to it.
function forkPrompt(facts: {
  now: string
  cwd: string
  project: string | null
  projects: string
  sessionId: string
  model: string
  tokens: number
  key: string
  git: string
  previous: string
}): string {
  return [
    `[auto-handoff] This session has reached ${facts.tokens} tokens of a 1,000,000-token window.`,
    'Write the /next handoff for this session now. You have no tools: do not try to run anything,',
    'and do not do any of the remaining work. Use only this conversation and the facts below.',
    '',
    'FACTS',
    `Date: ${facts.now}`,
    `Working directory: ${facts.cwd}`,
    facts.project
      ? `Project: ${facts.project}`
      : `Project: undetermined. Pick the existing project this session was about from this list (name, latest handoff), or coin a short kebab-case name:\n${facts.projects}`,
    `Harness: Claude Code, model ${facts.model}. Session: ${facts.sessionId}`,
    `git status --short / git diff --stat:\n${facts.git || '(not a git repository, or clean)'}`,
    facts.previous
      ? `Previous handoff for this project (do not repeat its settled decisions):\n${facts.previous}`
      : 'Previous handoff: none.',
    '',
    'OUTPUT: exactly these two lines, then the handoff markdown, nothing else:',
    'PROJECT: <project, kebab-case>',
    'SLUG: <2-4 word kebab-case slug>',
    '',
    '# Handoff: <one-line outcome or active objective>',
    'Date: <the date above>',
    'Project: <project>',
    'Working directory: <absolute path>',
    'Harness: <harness and model>. Session: <id>',
    `Attempt-Key: ${facts.key}`,
    '',
    '## Where we are',
    '<What is done and verified, and the current state: uncommitted changes, running processes, partial work.>',
    '',
    '## What we decided',
    '- <Decision. Why: reason.> (one standalone bullet per decision made THIS session, or "- None")',
    '',
    '## Next step',
    '<The single first concrete action for the next session, and why it is next.>',
    '',
    '## Remaining',
    '### Ready',
    '### Needs Matthew',
    '### Later',
    '',
    '## Claims to verify',
    '- <A fact the next session depends on> : `<read-only command that checks it>` (3 to 6 items)',
    '',
    '## References',
    '<Absolute paths, commits, issue IDs, plans. Point to detail; do not copy it.>',
    '',
    'RULES: under 500 words. Mark anything unverified as unverified; distinguish what was checked,',
    'what Matthew said, and what is assumed. Approvals do not carry over: list what was granted this',
    'session and what still needs approval. No secrets or tokens (write [REDACTED]). No em dashes.',
  ].join('\n')
}

async function exec($: EngineInterface, argv: string[], cwd?: string): Promise<{ ok: boolean; out: string }> {
  try {
    const r = await $.process.run(argv, cwd ? { cwd } : undefined)
    return { ok: r.exitCode === 0, out: (r.exitCode === 0 ? r.stdout : r.stderr || r.stdout).trim() }
  } catch (err) {
    return { ok: false, out: String(err) }
  }
}

async function setRun($: EngineInterface, value: HandoffRun): Promise<void> {
  await update($, last, () => value)
  await update($, isDismissed, () => false)
}

async function writeHandoff($: EngineInterface, tokens: number): Promise<void> {
  if (isWriting) {
    return
  }
  isWriting = true
  const fail = async (detail: string, project = '') => {
    await setRun($, { status: 'failed', tokens, project, path: '', detail })
    $.ui.toast(`Auto-handoff failed: ${detail}`, { timeoutMs: 10_000 })
  }
  try {
    await setRun($, { status: 'writing', tokens, project: '', path: '', detail: '' })
    const home = (await $.env.get('HOME')) ?? '/home/apexaipc'
    const script = `${home}/.claude/skills/next/scripts/handoff.mjs`
    const cwd = await $.session.cwd()
    const sessionId = await $.session.id()
    const crossing = await update($, crossings, n => n + 1)
    const key = `auto-${sessionId.slice(0, 8)}-${crossing}`

    // /next Step 1: the git root's name, or refused in the home folder.
    const resolved = await exec($, ['node', script, 'project'], cwd)
    const projects = resolved.ok ? '' : (await exec($, ['node', script, 'list'], cwd)).out

    // /next Step 2: git state and the previous handoff.
    const status = await exec($, ['git', '-C', cwd, 'status', '--short'])
    const stat = await exec($, ['git', '-C', cwd, 'diff', '--stat'])
    const git = status.ok ? `${status.out}\n${stat.out}`.trim() : ''
    let previous = ''
    if (resolved.ok) {
      const latest = await exec($, ['node', script, 'latest', '--project', resolved.out], cwd)
      if (latest.ok && latest.out) {
        previous = ((await $.fs.read(latest.out).catch(() => '')) as string).slice(0, 4000)
      }
    }

    // /next Step 3: the draft, from the session's own context.
    const reply = await $.model.fork({
      prompt: forkPrompt({
        now: (await exec($, ['date', '+%Y-%m-%d %H:%M %Z'])).out,
        cwd,
        project: resolved.ok ? resolved.out : null,
        projects,
        sessionId,
        model: await $.session.model(),
        tokens,
        key,
        git,
        previous,
      }),
    })
    if (!reply.isAnswered) {
      await fail(`the fork returned no draft (${reply.reason})`)
      return
    }
    const parsed = parseReply(reply.text, key)
    if ('error' in parsed) {
      await fail(parsed.error)
      return
    }
    const project = resolved.ok ? resolved.out : parsed.project

    // /next Step 4: handoff.mjs owns LATEST, Supersedes and DECISIONS.md.
    const draft = `${home}/.claude/auto-handoff/drafts/${key}.md`
    await $.fs.write(draft, parsed.markdown)
    const saved = await exec($, [
      'node', script, 'save', '--slug', parsed.slug, '--file', draft, '--project', project, '--key', key,
    ], cwd)
    if (!saved.ok) {
      await fail(`handoff.mjs refused the draft: ${saved.out.slice(0, 160)}`, project)
      return
    }
    await setRun($, { status: 'saved', tokens, project, path: saved.out, detail: '' })
    $.ui.toast(`Handoff saved: ${saved.out}. Next: /clear, then /prime ${project}`, { timeoutMs: 15_000 })
  } catch (err) {
    await fail(String(err).slice(0, 160))
  } finally {
    isWriting = false
  }
}

// The pickup line in one press. /clear ends the conversation but not this
// module (no session.start follows it), so /prime still runs from here.
// Dismissed first, so a second press cannot clear twice.
async function clearAndPrime($: EngineInterface, project: string): Promise<void> {
  await update($, isDismissed, () => true)
  try {
    await $.command.run({ command: 'clear' })
  } catch (err) {
    await update($, isDismissed, () => false)
    $.ui.toast(`/clear did not run (${String(err).slice(0, 120)}). Run /clear, then /prime ${project}`, {
      timeoutMs: 15_000,
    })
    return
  }
  try {
    await $.command.run({ command: 'prime', args: project })
  } catch (err) {
    $.ui.toast(`Cleared, but /prime did not run (${String(err).slice(0, 120)}). Run /prime ${project}`, {
      timeoutMs: 15_000,
    })
  }
}

function parseReply(
  text: string,
  key: string,
): { project: string; slug: string; markdown: string } | { error: string } {
  const project = /^PROJECT:\s*([a-z0-9][a-z0-9-]*)\s*$/m.exec(text)?.[1]
  const slug = /^SLUG:\s*([a-z0-9][a-z0-9-]*)\s*$/m.exec(text)?.[1]
  const start = text.search(/^# Handoff:/m)
  if (!project || !slug || start < 0) {
    return { error: 'the draft is missing its PROJECT, SLUG or "# Handoff:" line' }
  }
  let markdown = text
    .slice(start)
    .replace(/\s*—\s*/g, ', ')
    .replace(/–/g, '-')
    .replace(/^```\w*\s*$/gm, '')
    .trim()
  if (!markdown.includes(`Attempt-Key: ${key}`)) {
    markdown = markdown.replace(/^(# Handoff:.*)$/m, `$1\nAttempt-Key: ${key}`)
  }
  for (const heading of ['## Where we are', '## What we decided', '## Next step']) {
    if (!markdown.includes(heading)) {
      return { error: `the draft is missing "${heading}"` }
    }
  }
  return { project, slug, markdown: `${markdown}\n` }
}

function short(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(n % 1_000_000 === 0 ? 0 : 1)}M`
  if (n >= 1_000) return `${Math.round(n / 1_000)}k`
  return String(n)
}
