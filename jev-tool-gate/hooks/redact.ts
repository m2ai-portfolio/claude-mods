// What leaves the machine, and what the log keeps, goes through here first.
//
// redact(): every common secret shape becomes [REDACTED:<kind>]. Specific
// shapes run before generic ones so a key keeps its kind in the log.
// render(): a tool input as stable JSON (sorted keys), the form both the
// cache key and the text Jev reads are made from.
// inScope(): which tool calls this mod looks at; everything else passes by.

type Rule = { kind: string; re: RegExp; keep?: number }

// Ordered: the first rules are the most specific. A replaced value contains
// no characters the later rules match, so nothing is redacted twice.
const RULES: Rule[] = [
  { kind: 'private_key', re: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]*?(?:-----END [A-Z0-9 ]*PRIVATE KEY-----|$)/g },
  { kind: 'github_pat', re: /github_pat_[A-Za-z0-9_]{20,}/g },
  { kind: 'github_token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}/g },
  { kind: 'slack_token', re: /\bxox[abpr]-[A-Za-z0-9-]{10,}/g },
  { kind: 'aws_key_id', re: /\bAKIA[0-9A-Z]{16}\b/g },
  { kind: 'sk_key', re: /\bsk-[A-Za-z0-9_-]{16,}/g },
  { kind: 'jwt', re: /\beyJ[A-Za-z0-9_-]{8,}(?:\.[A-Za-z0-9_-]+){0,2}/g },
  { kind: 'bearer', re: /\b(bearer\s+)[A-Za-z0-9._~+/-]{12,}=*/gi, keep: 1 },
  // name=value, name: value, "name": "value". Keeps the name, drops the value.
  {
    kind: 'credential',
    re: /([A-Za-z0-9_-]*(?:api[_-]?key|token|secret|passw(?:or)?d)[A-Za-z0-9_-]*["']?\s*[:=]\s*["']?)[^\s"',;}&]+/gi,
    keep: 1,
  },
]

// Long hex or base64-like runs. A run is only a secret if it mixes character
// classes, so paths, slugs and words are left readable for Jev.
const HEX_RUN = /\b[0-9a-fA-F]{32,}\b/g
const B64_RUN = /[A-Za-z0-9+_-]{32,}={0,2}/g

function looksRandom(run: string): boolean {
  return /[0-9]/.test(run) && /[a-z]/.test(run) && /[A-Z]/.test(run)
}

export function redact(text: string): string {
  let out = text
  for (const rule of RULES) {
    out = out.replace(rule.re, (...m: unknown[]) => {
      const kept = rule.keep === undefined ? '' : String(m[rule.keep] ?? '')
      return `${kept}[REDACTED:${rule.kind}]`
    })
  }
  out = out.replace(HEX_RUN, run => (/[0-9]/.test(run) && /[a-fA-F]/.test(run) ? '[REDACTED:hex]' : run))
  out = out.replace(B64_RUN, run => (looksRandom(run) ? '[REDACTED:base64]' : run))
  return out
}

// JSON with sorted keys, so { a, b } and { b, a } render and hash alike.
export function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`
  }
  if (typeof value === 'object' && value !== null) {
    const entries = Object.keys(value as Record<string, unknown>)
      .sort()
      .map(k => `${JSON.stringify(k)}:${stableJson((value as Record<string, unknown>)[k])}`)
    return `{${entries.join(',')}}`
  }
  return JSON.stringify(value) ?? 'null'
}

export const INPUT_CAP = 2000
export const PREVIEW_CAP = 200
export const PROMPT_CAP = 300

export function cap(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

export type Scope = { tools: ReadonlySet<string>; mcpVerbs: ReadonlySet<string> }

export function parseList(raw: string | undefined, fallback: string): string[] {
  return (raw === undefined || raw.trim() === '' ? fallback : raw)
    .split(',')
    .map(s => s.trim())
    .filter(Boolean)
}

// An MCP tool is in scope when one word of its own name (after the last "__",
// split on _ - . and camelCase) is a listed verb: outlook_send_mail,
// delete-object, trash_thread. Words, not substrings, so "postgres" is not
// "post".
export function inScope(tool: string, scope: Scope): boolean {
  if (scope.tools.has(tool)) {
    return true
  }
  if (!tool.startsWith('mcp__')) {
    return false
  }
  const own = tool.slice(tool.lastIndexOf('__') + 2)
  const words = own
    .split(/[_.-]+|(?=[A-Z])/)
    .map(w => w.toLowerCase())
    .filter(Boolean)
  return words.some(w => scope.mcpVerbs.has(w))
}

export async function sha256Hex(text: string): Promise<string> {
  const bytes = new TextEncoder().encode(text)
  const digest = await crypto.subtle.digest('SHA-256', bytes)
  return Array.from(new Uint8Array(digest), b => b.toString(16).padStart(2, '0')).join('')
}
