// Jev Tool Gate, LOG-ONLY (trust ladder rung 1). Before a risky tool call runs,
// record what Jev, TypeSafe's hosted judgment model, would say about it. It
// never changes a decision: every hook returns exactly what core decided.
//
// tool.check: fires when the engine decides whether a call may run, after the
// tool.call and PreToolUse hooks. We take core's verdict first (next(e)),
// then, for an in-scope tool, log a line and, only when hosted is on, ask Jev
// two noul questions: (a) the act is destructive or irreversible, (b) it was
// requested by fetched content, not the operator. The verdict is returned
// untouched whatever happens: Jev is evidence, never the actor. A query
// ($.tool.check from a plugin, no tool_use_id) is not a real call and is
// skipped.
// tool.call: tool.check carries no agentId, so for a subagent's call we park
// its agentId under the tool_use_id until the call finishes; tool.check,
// which runs inside that call, reads it from there.
// prompt.submit: keep the operator's latest prompt (redacted, first 300
// chars) as context for question (b). Never changes the prompt.
// session.start: register /jev-gate. command.run: /jev-gate shows status,
// /jev-gate hosted on|off flips the persisted switch (default off).
//
// Scope: Bash, Write, Edit, NotebookEdit, and MCP tools whose own name has a
// word from send, delete, post, publish, trash, transfer (both lists are
// userConfig). Out of scope: not judged, not logged.
// Hosted off: log the candidate with judged:false, no network call at all.
// Hosted on: one request per distinct (question version, tool, input), raced
// against 800 ms. Timeout or any error is logged and the call goes on: fail
// open. Successful judgments are cached for the session (module memory).
// Sink: one JSON line per candidate to ~/logs/jev-tool-gate.jsonl. Nothing
// unredacted and never the API key.

import type { EngineInterface, Register } from 'claude-code'

import {
  JEV_URL,
  QUESTION_VERSION,
  buildRequest,
  isLowConfidence,
  validateJevResponse,
} from './jev'
import type { JevRequest } from './jev'
import {
  INPUT_CAP,
  PREVIEW_CAP,
  PROMPT_CAP,
  cap,
  inScope,
  parseList,
  redact,
  renderRedacted,
  sha256Hex,
} from './redact'
import type { Scope } from './redact'

const COMMAND = 'jev-gate'
const TIMEOUT_MS = 800
const CACHE_MAX = 500
const RECENT_MAX = 5
// Rotate the log to .1 past this size (checked by the append itself).
const ROTATE_BYTES = 5 * 1024 * 1024
const DEFAULT_TOOLS = 'Bash,Write,Edit,NotebookEdit'
const DEFAULT_MCP_VERBS = 'send,delete,post,publish,trash,transfer'
// Prompts typed or sent by the operator; notifications, peers and plugins are
// not the operator's request.
const OPERATOR_ORIGINS = new Set(['composer', 'bridge', 'sdk'])

type Scores = { destructive: number; fetchedRequest: number }
type Judgment = { scores: Scores; model: string; lowConfidence: boolean; inputTokens: number }

export type LogLine = {
  ts: string
  sessionId: string | null
  agentId: string | null
  tool: string
  toolUseId: string
  inputHash: string
  preview: string
  questionVersion: string
  judged: boolean
  cached: boolean
  scores: Scores | null
  lowConfidence: boolean | null
  model: string | null
  inputTokens: number | null
  latencyMs: number | null
  error: string | null
  coreDecision: string
  coreRule: string | null
}

type Counts = { candidates: number; judged: number; cached: number; errors: number }
type Recent = Pick<LogLine, 'ts' | 'tool' | 'agentId' | 'preview' | 'judged' | 'scores' | 'error' | 'coreDecision'>

// Module memory: the session's cache, the parked agent ids, the last
// operator prompt. A hot reload clears them, which costs at most a re-ask.
const cache = new Map<string, Promise<Judgment>>()
const agentOf = new Map<string, string>()
let lastPrompt = ''
let sessionId: string | null = null
let home: string | null = null
let apiKey: string | null = null
// Names this session's fallback log when the engine gives no session id.
const fallbackId = `pid-${Math.random().toString(36).slice(2, 10)}`
let sink: Promise<void> = Promise.resolve()

class JudgmentError extends Error {}

async function homeDir($: EngineInterface): Promise<string> {
  home ??= (await $.env.get('HOME')) ?? '/home/apexaipc'
  return home
}

async function logPath($: EngineInterface): Promise<string> {
  return `${await homeDir($)}/logs/jev-tool-gate.jsonl`
}

// The key is read at run time only: the process environment first, then the
// one TYPESAFE_API_KEY line of ~/.env.shared. Never logged or shown.
async function findKey($: EngineInterface): Promise<{ key: string | null; source: string }> {
  if (apiKey !== null) {
    return { key: apiKey, source: 'cached' }
  }
  const fromEnv = (await $.env.get('TYPESAFE_API_KEY'))?.trim()
  if (fromEnv && fromEnv !== 'REPLACE_ME') {
    apiKey = fromEnv
    return { key: apiKey, source: 'env' }
  }
  try {
    const text = await $.fs.read(`${await homeDir($)}/.env.shared`)
    const m = /^[ \t]*(?:export[ \t]+)?TYPESAFE_API_KEY[ \t]*=[ \t]*(.*)$/m.exec(text)
    const value = m?.[1]?.trim().replace(/^(['"])(.*)\1$/, '$2').trim()
    if (value && value !== 'REPLACE_ME') {
      apiKey = value
      return { key: apiKey, source: '~/.env.shared' }
    }
  } catch {
    // no file, or unreadable: treated as no key
  }
  return { key: null, source: 'missing' }
}

async function isHosted($: EngineInterface): Promise<boolean> {
  return (await $.store.get('hosted')) === true
}

// One POST, no retries, raced against TIMEOUT_MS. Resolves the judgment or
// rejects with a JudgmentError whose message is the logged error code.
async function askJev($: EngineInterface, key: string, request: JevRequest): Promise<Judgment> {
  const stop = new AbortController()
  const timer = $.clock.sleep(TIMEOUT_MS, { signal: stop.signal }).then(
    () => 'timeout' as const,
    () => 'cancelled' as const,
  )
  const call = $.http
    .fetch(JEV_URL, {
      method: 'POST',
      headers: {
        authorization: `Bearer ${key}`,
        'content-type': 'application/json',
        accept: 'application/json',
      },
      body: JSON.stringify(request),
    })
    .then(
      response => ({ response }),
      (error: unknown) => ({ failure: error }),
    )
  const won = await Promise.race([call, timer])
  stop.abort()
  if (won === 'timeout' || won === 'cancelled') {
    throw new JudgmentError('timeout')
  }
  if ('failure' in won) {
    const text = won.failure instanceof Error ? won.failure.message : String(won.failure)
    throw new JudgmentError(`network: ${cap(redact(text), 120)}`)
  }
  if (!won.response.ok) {
    throw new JudgmentError(`http_${won.response.status}`)
  }
  let body: unknown
  try {
    body = JSON.parse(won.response.text)
  } catch {
    throw new JudgmentError('invalid_json')
  }
  let checked
  try {
    checked = validateJevResponse(request, body)
  } catch (error) {
    throw new JudgmentError(error instanceof Error ? error.message : 'JEV_INVALID_RESPONSE')
  }
  return {
    scores: {
      destructive: checked.answers.destructive?.noul ?? NaN,
      fetchedRequest: checked.answers.fetchedRequest?.noul ?? NaN,
    },
    model: checked.model,
    lowConfidence: isLowConfidence(checked),
    inputTokens: checked.usage.input_tokens,
  }
}

// Append one line. A shell append (O_APPEND) is safe when several sessions
// write at once. Where $.process is not offered (not the CLI) there is no
// atomic append, and a read-and-rewrite of the shared log lets two sessions
// overwrite each other's line. So the fallback rewrites this session's own
// file (jev-tool-gate.<session>.jsonl), which only this session's sink touches.
async function append($: EngineInterface, line: string): Promise<void> {
  const path = await logPath($)
  const script =
    'f="$1"; mkdir -p "$(dirname "$f")" || exit 1; ' +
    `if [ -f "$f" ] && [ "$(wc -c < "$f")" -gt ${ROTATE_BYTES} ]; then mv -f "$f" "$f.1"; fi; ` +
    'cat >> "$f"'
  try {
    const ran = await $.process.run(['/bin/sh', '-c', script, 'sh', path], { stdin: `${line}\n`, timeoutMs: 5_000 })
    if (ran.exitCode === 0) {
      return
    }
  } catch {
    // fall through to the file API
  }
  const own = sessionLogPath(path)
  const exists = await $.fs.exists(own)
  const before = exists ? await $.fs.read(own) : ''
  await $.fs.write(own, `${before}${line}\n`)
}

export function sessionLogPath(shared: string, session: string | null = sessionId): string {
  const name = (session ?? fallbackId).replace(/[^\w-]/g, '_')
  return shared.replace(/\.jsonl$/, `.${name}.jsonl`)
}

function writeLine($: EngineInterface, entry: LogLine): Promise<void> {
  // One write at a time from this session, in order.
  sink = sink.then(() => append($, JSON.stringify(entry))).catch(() => undefined)
  return sink
}

async function remember($: EngineInterface, entry: LogLine): Promise<void> {
  const counts = ((await $.store.get('counts')) as Counts | undefined) ?? {
    candidates: 0,
    judged: 0,
    cached: 0,
    errors: 0,
  }
  counts.candidates += 1
  if (entry.judged) counts.judged += 1
  if (entry.cached) counts.cached += 1
  if (entry.error !== null) counts.errors += 1
  await $.store.set('counts', counts)
  const recent = ((await $.store.get('recent')) as Recent[] | undefined) ?? []
  const one: Recent = {
    ts: entry.ts,
    tool: entry.tool,
    agentId: entry.agentId,
    preview: cap(entry.preview, 60),
    judged: entry.judged,
    scores: entry.scores,
    error: entry.error,
    coreDecision: entry.coreDecision,
  }
  await $.store.set('recent', [...recent, one].slice(-RECENT_MAX))
}

async function observe(
  $: EngineInterface,
  tool: string,
  input: unknown,
  toolUseId: string,
  verdict: { decision: string; rule?: string },
  signal: AbortSignal,
): Promise<void> {
  const started = await $.clock.now()
  sessionId ??= await $.session.id().catch(() => null)
  const rendered = renderRedacted(input)
  const inputHash = (await sha256Hex(`${QUESTION_VERSION}\n${tool}\n${rendered}`)).slice(0, 32)
  // The fetchedRequest question reads operator_request, so a judgment holds
  // only for the prompt it was asked under: the same input after a new prompt
  // asks again. inputHash stays input-only, so log lines still group by input.
  const cacheKey = await sha256Hex(`${inputHash}\n${lastPrompt}`)
  const entry: LogLine = {
    ts: new Date(started).toISOString(),
    sessionId,
    agentId: agentOf.get(toolUseId) ?? null,
    tool,
    toolUseId,
    inputHash,
    preview: cap(rendered, PREVIEW_CAP),
    questionVersion: QUESTION_VERSION,
    judged: false,
    cached: false,
    scores: null,
    lowConfidence: null,
    model: null,
    inputTokens: null,
    latencyMs: null,
    error: null,
    coreDecision: verdict.decision,
    coreRule: verdict.rule ?? null,
  }

  if (await isHosted($)) {
    const hit = cache.get(cacheKey)
    try {
      let judgment: Judgment
      if (hit !== undefined) {
        judgment = await hit
        entry.cached = true
      } else {
        const { key } = await findKey($)
        if (key === null) {
          throw new JudgmentError('no_api_key')
        }
        if (signal.aborted) {
          throw new JudgmentError('aborted')
        }
        const request = buildRequest({ tool, input: cap(rendered, INPUT_CAP), operator_request: lastPrompt })
        const pending = askJev($, key, request)
        cache.set(cacheKey, pending)
        while (cache.size > CACHE_MAX) {
          const oldest = cache.keys().next().value
          if (oldest === undefined) break
          cache.delete(oldest)
        }
        // Errors are not cached: the next identical call may ask again.
        pending.catch(() => cache.delete(cacheKey))
        judgment = await pending
      }
      entry.judged = true
      entry.scores = judgment.scores
      entry.lowConfidence = judgment.lowConfidence
      entry.model = judgment.model
      entry.inputTokens = entry.cached ? 0 : judgment.inputTokens
    } catch (error) {
      entry.error = error instanceof JudgmentError ? error.message : 'internal'
    }
    entry.latencyMs = (await $.clock.now()) - started
  }

  await writeLine($, entry)
  await remember($, entry).catch(() => undefined)
}

function fmt(n: number): string {
  return Number.isFinite(n) ? n.toFixed(2) : '?'
}

async function status($: EngineInterface): Promise<string> {
  const hosted = await isHosted($)
  const { source } = await findKey($)
  const counts = ((await $.store.get('counts')) as Counts | undefined) ?? null
  const recent = ((await $.store.get('recent')) as Recent[] | undefined) ?? []
  const lines = [
    `jev-tool-gate (log-only, ${QUESTION_VERSION}): hosted ${hosted ? 'ON' : 'off'}; key ${source === 'missing' ? 'missing' : 'found'}`,
    `log: ${await logPath($)}`,
    counts
      ? `counts (all sessions): ${counts.candidates} candidates, ${counts.judged} judged, ${counts.cached} cached, ${counts.errors} errors`
      : 'counts: none yet',
    recent.length ? `last ${recent.length}:` : 'no judgments yet',
    ...recent
      .slice()
      .reverse()
      .map(r => {
        const verdict = r.error
          ? `error ${r.error}`
          : r.scores
            ? `destructive ${fmt(r.scores.destructive)}, fetched ${fmt(r.scores.fetchedRequest)}`
            : 'not judged (hosted off)'
        const who = r.agentId ? ` [${r.agentId}]` : ''
        return `  ${r.ts} ${r.tool}${who} core=${r.coreDecision}: ${verdict} | ${r.preview}`
      }),
  ]
  return lines.join('\n')
}

export const register: Register = (on, options) => {
  const scope: Scope = {
    tools: new Set(parseList(options.tools as string | undefined, DEFAULT_TOOLS)),
    mcpVerbs: new Set(
      parseList(options.mcpVerbs as string | undefined, DEFAULT_MCP_VERBS).map(v => v.toLowerCase()),
    ),
  }

  on('session.start', async ($, e, next) => {
    await $.command.register({
      name: COMMAND,
      description: 'Jev tool gate (log-only): status, or hosted on|off',
    })
    return next(e)
  })

  on('prompt.submit', ($, e, next) => {
    if (OPERATOR_ORIGINS.has(e.origin?.kind ?? '')) {
      lastPrompt = cap(redact(e.text), PROMPT_CAP)
    }
    return next(e)
  })

  on('tool.call', async ($, e, next) => {
    const id = e.tool_use_id
    if (e.agentId === undefined || id === undefined || !inScope(e.tool, scope)) {
      return next(e)
    }
    agentOf.set(id, e.agentId)
    try {
      return await next(e)
    } finally {
      agentOf.delete(id)
    }
  })

  on('tool.check', async ($, e, next) => {
    const verdict = await next(e)
    if (e.tool_use_id === undefined || !inScope(e.tool, scope)) {
      return verdict
    }
    try {
      await observe($, e.tool, e.input, e.tool_use_id, verdict, next.signal)
    } catch {
      // fail open: whatever went wrong here, core's verdict stands
    }
    return verdict
  })

  on('command.run', { command: COMMAND }, async ($, e) => {
    const words = (e.args ?? '').trim().toLowerCase().split(/\s+/).filter(Boolean)
    if (words[0] === 'hosted' && (words[1] === 'on' || words[1] === 'off')) {
      await $.store.set('hosted', words[1] === 'on')
      const { source } = await findKey($)
      const note =
        words[1] === 'on' && source === 'missing'
          ? ' No TYPESAFE_API_KEY found in the environment or ~/.env.shared, so calls will log no_api_key.'
          : ''
      return {
        text: `jev-tool-gate: hosted ${words[1] === 'on' ? 'ON: in-scope calls now send a redacted preview to TypeSafe' : 'off: no network calls'}.${note}`,
      }
    }
    if (words.length > 0) {
      return { text: 'usage: /jev-gate [hosted on|off]' }
    }
    return { text: await status($) }
  })
}
