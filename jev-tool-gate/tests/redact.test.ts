import { describe, expect, test, tier } from 'claude-code/testing'

import { isLowConfidence, validateJevResponse, buildRequest } from '../hooks/jev'
import { inScope, redact, stableJson } from '../hooks/redact'

tier('user')

// Every value here is fake, built to the shape only.
const CASES: [string, string, string][] = [
  ['sk- key', 'key is sk-ant-api03-FAKEfakeFAKEfake1234 ok', 'sk_key'],
  ['gho_ token', 'gho_FAKEfakeFAKEfake1234567890ab', 'github_token'],
  ['ghp_ token', 'ghp_FAKEfakeFAKEfake1234567890ab', 'github_token'],
  ['github_pat_', 'github_pat_11FAKEfake0000000000_abcdefghij', 'github_pat'],
  ['slack xoxb-', 'xoxb-1234567890-FAKEfake', 'slack_token'],
  ['slack xoxp-', 'xoxp-1234567890-FAKEfake', 'slack_token'],
  ['AWS key id', 'AKIAFAKEFAKEFAKE1234', 'aws_key_id'],
  [
    'private key',
    '-----BEGIN RSA PRIVATE KEY-----\nMIIEfakefakefake\nabc\n-----END RSA PRIVATE KEY-----', // gitleaks:allow (fake test fixture)
    'private_key',
  ],
  ['openssh private key', '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXk', 'private_key'],
  ['JWT', 'eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0In0.c2lnbmF0dXJlZmFrZQ', 'jwt'], // gitleaks:allow (fake test fixture)
  ['api_key=', 'api_key=hunter2hunter2', 'credential'],
  ['API-KEY:', 'API-KEY: hunter2hunter2', 'credential'],
  ['TOKEN env', 'export GITHUB_TOKEN=hunter2hunter2', 'credential'],
  ['secret json', '{"client_secret": "hunter2hunter2"}', 'credential'],
  ['password=', 'mysql -u root password=hunter2', 'credential'],
  ['bearer', 'Authorization: Bearer abcdefghijklmnop.qrstu', 'bearer'],
  ['long hex', 'sum 9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08 end', 'hex'],
  ['long base64', 'blob QWxhZGRpbjpvcGVuIHNlc2FtZQ9xY2FtZQ9xY2FtZQ9x end', 'base64'],
]

describe('redact', () => {
  for (const [name, input, kind] of CASES) {
    test(`strips ${name}`, () => {
      const out = redact(input)
      expect(out).toContain(`[REDACTED:${kind}]`)
      expect(out).not.toContain('FAKEfake')
      expect(out).not.toContain('hunter2')
    })
  }

  test('keeps the name of a name=value credential', () => {
    expect(redact('OPENAI_API_KEY=abc123xyz')).toBe('OPENAI_API_KEY=[REDACTED:credential]')
  })

  test('leaves ordinary commands, paths and slugs readable', () => {
    const plain = [
      'git push origin feature/jev-tool-gate-2026-10-04',
      'rm -rf /home/apexaipc/projects/st-metro/metroplex/build/output-directory',
      'ls -la ~/.claude/agents/.artifacts/general-jev-tool-gate.md',
      'npm run build && npm test',
    ]
    for (const text of plain) {
      expect(redact(text)).toBe(text)
    }
  })

  test('redacts inside stable JSON of a tool input', () => {
    const out = redact(stableJson({ command: 'curl -H "x-api-key: hunter2hunter2" https://x' })) // gitleaks:allow (fake test fixture)
    expect(out).not.toContain('hunter2')
  })
})

describe('stableJson', () => {
  test('key order does not change the rendering', () => {
    expect(stableJson({ b: 1, a: { d: [1, 2], c: 'x' } })).toBe(stableJson({ a: { c: 'x', d: [1, 2] }, b: 1 }))
  })
})

describe('inScope', () => {
  const scope = { tools: new Set(['Bash']), mcpVerbs: new Set(['send', 'delete', 'post']) }
  test('names and words, not substrings', () => {
    expect(inScope('Bash', scope)).toBe(true)
    expect(inScope('Read', scope)).toBe(false)
    expect(inScope('mcp__a__outlook_send_mail', scope)).toBe(true)
    expect(inScope('mcp__a__sendMessage', scope)).toBe(true)
    expect(inScope('mcp__a__delete-object', scope)).toBe(true)
    expect(inScope('mcp__a__postgres_query', scope)).toBe(false)
    expect(inScope('mcp__send__list_items', scope)).toBe(false)
  })
})

describe('validateJevResponse', () => {
  const request = buildRequest({ tool: 'Bash', input: 'x', operator_request: '' })
  const good = {
    model: 'jev',
    answers: { destructive: { type: 'noul', noul: 0.9 }, fetchedRequest: { type: 'noul', noul: 0.1 } },
    usage: { input_tokens: 10 },
  }
  test('accepts a well-formed answer', () => {
    expect(validateJevResponse(request, good).answers.destructive?.noul).toBe(0.9)
  })
  test('rejects a missing answer, a wrong type, an out-of-range noul', () => {
    expect(() => validateJevResponse(request, { ...good, answers: { destructive: good.answers.destructive } })).toThrow(
      'JEV_QUESTION_MISMATCH',
    )
    expect(() =>
      validateJevResponse(request, {
        ...good,
        answers: { ...good.answers, destructive: { type: 'score', score: 1 } },
      }),
    ).toThrow('JEV_QUESTION_MISMATCH')
    expect(() =>
      validateJevResponse(request, {
        ...good,
        answers: { ...good.answers, destructive: { type: 'noul', noul: 1.5 } },
      }),
    ).toThrow('JEV_INVALID_RESPONSE')
  })
  test('low confidence is a noul leaning less than 0.8 either way', () => {
    expect(isLowConfidence(validateJevResponse(request, good))).toBe(false)
    const unsure = { ...good, answers: { ...good.answers, destructive: { type: 'noul', noul: 0.6 } } }
    expect(isLowConfidence(validateJevResponse(request, unsure))).toBe(true)
  })
})
