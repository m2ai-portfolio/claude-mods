// Auto Handoff: runs /next for you before a long session gets heavy.
//
// turn.complete (main loop): read the context fill. In a 1,000,000-token
// window, the first reading at or past 300,000 tokens starts one handoff;
// dropping back below (a /clear, a compaction) re-arms it.
// The handoff: $.model.fork drafts it from the session's own transcript (a
// cached, tool-less question), in the exact /next format; handoff.mjs saves
// it, moves LATEST and appends DECISIONS.md, as /next's Step 4 does, and
// stamps the Transcript-Cutoff read just before the fork (/prime's tail check).
// ui.render (AbovePrompt): what happened and the pickup line (/clear, /prime);
// once saved, a button runs both. On the desktop a "Retire this session"
// toggle turns that button into "Retire session": rename this session to
// "⛔ HANDED OFF: /prime <project>", copy the /prime line, and archive it, so
// the pickup happens in a new session and this one is not reopened by mistake.
// (/clear keeps the same sidebar session, so the plain button leaves nothing
// old behind; retiring is for picking up somewhere else.)
// tool.call (main loop): once a threshold handoff is SAVED, the model's own
// tool calls are refused with a reason telling it to stop and hand Matthew the
// pickup line. Never while writing, never after a failed write, never in a
// subagent, never for a plugin's own call, never for TaskStop. Each refusal
// rereads the context first, so after a /clear or compaction it re-arms on
// the spot instead of blocking the /prime that follows.
// session.compact (main loop, any window size): before a compaction drops
// detail, write a handoff from the full transcript first, unless one already
// covers this context window (saved since the last /clear or compaction) or
// one is being written. It never blocks tool calls and never stops the
// compaction: a failed write is reported and the compaction goes on.
// (Adopted from Prompt Advisers' auto-handoff mod, 2026-10-08.)
// /auto-handoff: status; "now" writes one immediately; "unblock" lifts the
// block for the rest of this window.

import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register, RenderSurface } from 'claude-code'

import type { HandoffRun } from '../types'

const WINDOW = 1_000_000
const THRESHOLD = 300_000
// What the model may still call while blocked. TaskStop: a background agent
// left running would keep spending, and the artifact-watchdog's stall wake
// asks for exactly this call. Nothing else is needed to wrap up: the answer
// that tells Matthew to clear is plain text, and the handoff is already saved.
const WRAP_UP_TOOLS: ReadonlySet<string> = new Set(['TaskStop'])
// The desktop app's session tools, reached with the engine's own connection.
const SESSIONS = 'ccd_session_mgmt'

const isArmed = atom({ plugin: 'auto-handoff', key: 'isArmed' } as const, true)
const crossings = atom({ plugin: 'auto-handoff', key: 'crossings' } as const, 0)
const last = atom({ plugin: 'auto-handoff', key: 'last' } as const, null)
const isDismissed = atom({ plugin: 'auto-handoff', key: 'isDismissed' } as const, false)
const isBlocked = atom({ plugin: 'auto-handoff', key: 'isBlocked' } as const, false)
const isLifted = atom({ plugin: 'auto-handoff', key: 'isLifted' } as const, false)
const isRetiring = atom({ plugin: 'auto-handoff', key: 'isRetiring' } as const, false)
const isCovered = atom({ plugin: 'auto-handoff', key: 'isCovered' } as const, false)

let isWriting = false
// A retire in flight: a second press must not rename or archive twice.
let isRetiringNow = false

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    const result = await next(e)
    await $.command.register({
      name: 'auto-handoff',
      description: 'Auto-handoff status; "now" writes a /next handoff immediately; "unblock" lifts the tool-call block',
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
      await rearm($)
      return result
    }
    const { value: armed = true } = await $.state.get({ plugin: 'auto-handoff', key: 'isArmed' } as const)
    if (armed && !isWriting) {
      await update($, isArmed, () => false)
      // Outside this dispatch: the fork must not die with the turn's hook.
      $.clock.after(1, () => {
        void writeHandoff($, tokens, true)
      })
    }
    return result
  })

  on('session.compact', async ($, e, next) => {
    if (e.trigger === 'precompute' || e.agentId !== undefined) {
      return next(e)
    }
    const { context } = await $.session.usage()
    if (!isWriting && context.tokens !== undefined && !(await read($, isCovered))) {
      await writeHandoff($, context.tokens, false, `the conversation is about to be compacted (${e.trigger})`)
    }
    const result = await next(e)
    if (!('skip' in result && result.skip)) {
      await update($, isCovered, () => false)
    }
    return result
  })

  // A /clear ends this conversation (the process goes on): what was saved
  // covers the old window, not the new one.
  on('session.end', async ($, e, next) => {
    if (e.reason === 'clear') {
      await update($, isCovered, () => false)
    }
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    // A subagent's call, a plugin's own (the watchdog's Stop button), or a
    // wrap-up tool: never the block's business.
    if (e.agentId !== undefined || next.origin.plugin !== 'engine' || WRAP_UP_TOOLS.has(e.tool)) {
      return next(e)
    }
    const reason = await blockReason($)

    return reason === null ? next(e) : { deny: reason }
  })

  on('command.run', { command: 'auto-handoff' }, async ($, e) => {
    if (e.args.trim() === 'unblock') {
      const wasBlocked = await read($, isBlocked)
      await update($, isBlocked, () => false)
      await update($, isLifted, () => true)
      return {
        text: wasBlocked
          ? 'Tool calls unblocked for the rest of this context window. The block re-arms once the context drops below the threshold (a /clear or a compaction) and crosses it again.'
          : 'Tool calls were not blocked. No block will be set for the rest of this context window.',
      }
    }
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
        void writeHandoff($, tokens, false)
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
      (await read($, isCovered))
        ? 'Before a compaction: no new handoff, the last one covers this window.'
        : 'Before a compaction: writes a handoff first.',
      (await read($, isBlocked))
        ? 'Tool calls: BLOCKED (/auto-handoff unblock lifts it).'
        : (await read($, isLifted))
          ? 'Tool calls: unblocked for this window.'
          : 'Tool calls: not blocked.',
    ]
    return { text: lines.join('\n') }
  })

  on('ui.render', { component: 'AbovePrompt' }, async ($, e, next) => {
    const run = await read($, last)
    const blocked = await read($, isBlocked)
    // A block outlives Dismiss: the band is where Matthew learns why tools stopped.
    if (e.props.hasSurvey || run === null || ((await read($, isDismissed)) && !blocked)) {
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
    // Only the desktop app has a sidebar session to rename and archive.
    const canRetire = e.surface === 'desktop'
    const retiring = canRetire && (await read($, isRetiring))
    return (
      <Box flexDirection="column" paddingX={1}>
        <Box flexDirection="row">
          <Text color="green" bold>
            ✓ Handoff saved at {short(run.tokens)} tokens{' '}
          </Text>
          <Text dimColor>{run.path} </Text>
          {!blocked && dismiss}
        </Box>
        <Box flexDirection="row">
          {retiring ? (
            <Text>To continue in a new session: retire this one, then /prime {run.project} there </Text>
          ) : (
            <Text>To continue fresh: /clear, then /prime {run.project} </Text>
          )}
          <Button
            key="pickup"
            label={retiring ? 'Retire session' : `Clear and /prime ${run.project}`}
            variant="primary"
            onPress={press => (retiring ? retire($, run.project, press.surface) : clearAndPrime($, run.project))}
          />
          {canRetire && (
            <Button
              key="retire"
              label={`${retiring ? '[x]' : '[ ]'} Retire this session`}
              plain
              onPress={() => update($, isRetiring, v => !v)}
            />
          )}
        </Box>
        {blocked && (
          <Box flexDirection="row">
            <Text color="yellow" bold>
              ■ Claude's tool calls are blocked until you clear. /auto-handoff unblock continues here.
            </Text>
          </Box>
        )}
      </Box>
    )
  })
}

// The fork's instructions: /next Steps 2-3, with the facts a tool-less
// completion cannot look up handed to it.
function forkPrompt(facts: {
  why: string
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
    `[auto-handoff] ${facts.why} (${facts.tokens} tokens).`,
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
    '<What is done and verified, and the current state: uncommitted changes, running processes, partial work.',
    'Name the checks that ran (command and result) and the checks that did NOT run; never call an unrun test passed.>',
    '',
    '## What we decided',
    '- <Decision. Why: reason.> (one standalone bullet per decision made THIS session, or exactly "- None" with',
    '  nothing after it; an offer still waiting for approval goes under Needs you, not here)',
    '- Rejected: <a direction turned down that a later session might retry>. Why: <reason>.',
    '',
    '## Next step',
    '<The single first concrete action for the next session, and why it is next.>',
    '',
    '## Remaining',
    '### Ready',
    '### Needs you',
    '### Later',
    '',
    '## Claims to verify',
    '- <A fact the next session depends on> : `<read-only command that checks it>` (3 to 6 items;',
    '  plain read-only programs such as git, grep, jq, ls: /prime runs those, and asks before anything else)',
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

// Below the threshold again (a /clear, a compaction): the next crossing may
// write and block again, and an unblock no longer carries.
async function rearm($: EngineInterface): Promise<void> {
  await update($, isArmed, () => true)
  await update($, isBlocked, () => false)
  await update($, isLifted, () => false)
}

// Why a main-loop tool call is refused, or null to let it run. The block
// stands only on a saved threshold handoff in a window still past the
// threshold; the context is reread here because /clear raises no turn end
// before /prime's first tool call. Any error lets the call run: a broken gate
// must not wedge the session.
async function blockReason($: EngineInterface): Promise<string | null> {
  try {
    if (!(await read($, isBlocked))) {
      return null
    }
    const { context } = await $.session.usage()
    const tokens = context.tokens ?? 0
    if (context.window !== WINDOW || tokens < THRESHOLD) {
      await rearm($)
      return null
    }
    const run = await read($, last)
    if (run === null || run.status !== 'saved') {
      return null
    }
    return (
      `[auto-handoff] Context is at ${short(tokens)} tokens; a handoff was saved to ${run.path}. ` +
      'Make no more tool calls. Stop and tell Matthew to press "Clear and /prime ' +
      `${run.project}" above the prompt (or run /clear, then /prime ${run.project}), ` +
      'or to run /auto-handoff unblock to continue in this session.'
    )
  } catch {
    return null
  }
}

// isThreshold: started by crossing the threshold, so a save blocks tool
// calls. "/auto-handoff now" and a compaction pass false: those never block.
// why: the fork's first line, what prompted this handoff.
async function writeHandoff(
  $: EngineInterface,
  tokens: number,
  isThreshold: boolean,
  why = 'This session has reached its handoff point in a 1,000,000-token window',
): Promise<void> {
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
    const prompt = forkPrompt({
      why,
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
    })
    // The Transcript-Cutoff: the last transcript entry the fork replays, read just
    // before it starts. The session keeps talking while the fork drafts (2026-10-07:
    // a decision 16 s later never reached the handoff); /prime's tail check reads
    // everything after this entry. Unreadable: "none", and /prime falls back to Date.
    const cut = await exec($, ['node', script, 'cutoff', '--session', sessionId, '--cwd', cwd, '--fork'], cwd)
    const cutoff = cut.ok && cut.out ? cut.out : 'none'
    const reply = await $.model.fork({ prompt })
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
      '--cutoff', cutoff,
    ], cwd)
    if (!saved.ok) {
      await fail(`handoff.mjs refused the draft: ${saved.out.slice(0, 160)}`, project)
      return
    }
    await setRun($, { status: 'saved', tokens, project, path: saved.out, detail: '' })
    await update($, isCovered, () => true)
    if (isThreshold && !(await read($, isLifted))) {
      await update($, isBlocked, () => true)
    }
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
  // The window is fresh: /prime must be free to read and verify.
  await update($, isBlocked, () => false)
  try {
    await $.command.run({ command: 'prime', args: project })
  } catch (err) {
    $.ui.toast(`Cleared, but /prime did not run (${String(err).slice(0, 120)}). Run /prime ${project}`, {
      timeoutMs: 15_000,
    })
  }
}

// Retire: mark this session so it is not reopened, then archive it; the pickup
// happens in a new session. Rename first, so a declined or failed archive
// still leaves the session labelled. The archive ends the conversation, so
// nothing after a successful one runs here.
async function retire($: EngineInterface, project: string, surface: RenderSurface): Promise<void> {
  if (isRetiringNow) {
    return
  }
  isRetiringNow = true
  try {
    const pickup = `/prime ${project}`
    const renamed = await sessions($, 'set_session_title', { session_id: 'self', title: `⛔ HANDED OFF: ${pickup}` })
    const copied = await $.ui.copy({ text: pickup, surface }).catch(() => ({ isCopied: false }))
    const archived = await sessions($, 'archive_session', {
      session_id: 'self',
      reason: `Auto-handoff saved; continue with ${pickup} in a new session`,
    })
    if (archived.ok) {
      $.ui.toast(`Session retired. In a new session run ${pickup}${copied.isCopied ? ' (copied)' : ''}`, { timeoutMs: 15_000 })
      return
    }
    $.ui.toast(
      `${renamed.ok ? 'Renamed' : `Rename failed (${renamed.detail.slice(0, 80)})`}; archive did not happen ` +
        `(${archived.detail.slice(0, 120)}). Archive it from the sidebar, then ${pickup} in a new session.`,
      { timeoutMs: 20_000 },
    )
  } finally {
    isRetiringNow = false
  }
}

async function sessions(
  $: EngineInterface,
  tool: string,
  args: Record<string, unknown>,
): Promise<{ ok: boolean; detail: string }> {
  try {
    const r = await $.mcp.call(SESSIONS, tool, args)
    const detail = r.content.map(b => b.text ?? '').join(' ').trim()
    return { ok: !r.isError, detail: detail || (r.isError ? 'no reason given' : '') }
  } catch (err) {
    return { ok: false, detail: String(err) }
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
