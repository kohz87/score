import { expect, test } from 'vitest'
import { redact, redactBounded, redactValue } from '../src/redact.ts'

const cases: [string, string][] = [
  ['Bearer fixture-token.abc', 'Bearer [redacted]'],
  ['bearer abc+xyz/=', 'Bearer [redacted]'],
  ['sk-abcdefgh12345678', '[redacted]'],
  [`scm_${'Ab_-9'.repeat(8)}xyz`, '[redacted]'],
  [`posted scm_${'Q'.repeat(43)}, thanks`, 'posted [redacted], thanks'],
  [`(scm_${'Q'.repeat(43)})`, '([redacted])'],
  ['sk-or-abcdefgh12345678', '[redacted]'],
  ['ghp_abcdefgh12345678', '[redacted]'],
  ['github_pat_abcdefgh_12345678', '[redacted]'],
  ['AKIA1234567890ABCDEF', '[redacted]'],
  ['-----BEGIN PRIVATE KEY-----\nabc\n-----END PRIVATE KEY-----', '[redacted]'],
  ['-----BEGIN RSA PRIVATE KEY-----\nabc\n-----END RSA PRIVATE KEY-----', '[redacted]'],
  ['-----BEGIN EC PRIVATE KEY-----\nabc', '[redacted]'],
  ['?password=hunter2&x=ok', '?password=[redacted]&x=ok'],
  ['?token=abc%20def&x=1', '?token=[redacted]&x=1'],
  ['?api_key=abc&secret=def', '?api_key=[redacted]&secret=[redacted]'],
  ['https://h.test/p?access_token=abc&page=2', 'https://h.test/p?access_token=[redacted]&page=2'],
  ['https://h.test/p?sig=abc#frag', 'https://h.test/p?sig=[redacted]#frag'],
  ['postgres://user:hunter2@db.test/app', 'postgres://user:[redacted]@db.test/app'],
  ['PASSWORD=hunter2', 'PASSWORD=[redacted]'],
  ['OPENAI_API_KEY="abc def"', 'OPENAI_API_KEY=[redacted]'],
  ["CLIENT_SECRET='abc def'", 'CLIENT_SECRET=[redacted]'],
  ['{"password":"hunter2","ok":true}', '{"password":[redacted],"ok":true}'],
  ['{"token": "abc"}', '{"token": [redacted]}'],
  ['{"api_key":"abc"}', '{"api_key":[redacted]}'],
  ['key abcdef0123456789abcdef0123456789', 'key [redacted]'],
  ['token abcdefghijklmnopqrstuvwxyz_123456', 'token [redacted]'],
  ['secret: abcdefghijklmnopqrstuvwxyz123456', 'secret: [redacted]'],
  ['password abcdefghijklmnopqrstuvwxyz123456', 'password [redacted]'],
  ['normal text, no secrets', 'normal text, no secrets'],
  ['sk-short ghp_short', 'sk-short ghp_short'],
  ['AKIA12345678', 'AKIA12345678'],
  [
    '-----BEGIN PUBLIC KEY-----\nabc\n-----END PUBLIC KEY-----',
    '-----BEGIN PUBLIC KEY-----\nabc\n-----END PUBLIC KEY-----',
  ],
  ['key short token count', 'key short token count'],
  [
    'monkey=banana tokenizer=ok secretive=yes',
    'monkey=banana tokenizer=[redacted] secretive=[redacted]',
  ],
  ['0123456789abcdef0123456789abcdef', '0123456789abcdef0123456789abcdef'],
]
test.each(cases)('redacts %j', (input, expected) => {
  expect(redact(input)).toBe(expected)
})
test('scrubs a secret crossing the limit before truncation and preserves UTF-8 boundaries', () => {
  expect(redactBounded('prefix sk-abcdefghijklmnopqrstuv', 12)).toBe('prefix [reda')
  expect(redactBounded('é🐈x', 5)).toBe('é')
})
test('scrubs structured text without breaking JSON and removes exact credential echoes', () => {
  expect(
    redactValue({ output: 'odd-fixture-credential', token: 'short', nested: ['Bearer xyz'] }, [
      'odd-fixture-credential',
    ]),
  ).toEqual({ output: '[redacted]', token: '[redacted]', nested: ['Bearer [redacted]'] })
})

test.each([
  'TOKEN=[redacted]',
  'password= [redacted]',
  'Bearer [redacted]',
  'token=sk-abcdefghijklmnopqrstuv',
  'token abcdefghijklmnopqrstuvwxyz123456',
])('redaction is idempotent for %s', (input) => {
  const safe = redact(input)
  expect(redact(safe)).toBe(safe)
})
test('generic key labels require a secret-shaped long value', () => {
  expect(redact('key=short pattern_key="delete in root path"')).toBe(
    'key=short pattern_key="delete in root path"',
  )
  expect(redact('key=0123456789abcdef0123456789abcdef')).toBe('key=[redacted]')
})

test('structured redaction scrubs keys and masks entire credential subtrees', () => {
  const names = [
    'password',
    'pass-wd',
    'SECRET',
    'auth_token',
    'apiKey',
    'access key',
    'privateKey',
    'client-secret',
    'authorization',
    'Cookie',
    'credentials',
    'AWS_SECRET_ACCESS_KEY',
    'AWS_ACCESS_KEY_ID',
    'x-api-key',
  ]
  const input = Object.fromEntries(names.map((name) => [name, { nested: ['unshaped-secret'] }]))
  expect(redactValue(input)).toEqual(Object.fromEntries(names.map((name) => [name, '[redacted]'])))
  expect(redactValue({ nested: { 'sk-abcdefgh123456': 'key-leak' } })).toEqual({
    nested: { '[redacted]': 'key-leak' },
  })
})

test('credential-named fields keep numbers, booleans and null but mask anything that can hold a secret', () => {
  expect(
    redactValue({
      usage: { input_tokens: 12, output_tokens: 8, max_tokens: null, token_reused: false },
      apiKey: 'opaque',
      tokens: ['opaque'],
      secret: { nested: 1 },
    }),
  ).toEqual({
    usage: { input_tokens: 12, output_tokens: 8, max_tokens: null, token_reused: false },
    apiKey: '[redacted]',
    tokens: '[redacted]',
    secret: '[redacted]',
  })
})

const gateForms = [
  'apiKey=opaque-value',
  'AWS_SECRET_ACCESS_KEY=opaque-value',
  'AWS_ACCESS_KEY_ID: opaque-value',
  'clientSecret: opaque-value',
  '"apiKey": "opaque-value"',
  'Authorization: Basic b3BhcXVlLXZhbHVl',
  'Authorization: Bearer opaque-value',
  'ASIA1234567890ABCDEF',
  'AKIA1234567890ABCDEF',
]
test.each(gateForms)('gate #1 free text and nested value remove %s', (form) => {
  expect(redact(form)).toContain('[redacted]')
  expect(redact(form)).not.toMatch(/opaque-value|b3BhcXVlLXZhbHVl|[A-Z]{4}1234567890ABCDEF/)
  expect(redactValue({ command: form, result: [form] })).toEqual({
    command: redact(form),
    result: [redact(form)],
  })
})
test('gate #7 session identifiers survive while cookies remain credentials', () => {
  expect(
    redactValue({ session_id: 'session-a', sessionId: 'session-b', cookie: 'opaque' }),
  ).toEqual({ session_id: 'session-a', sessionId: 'session-b', cookie: '[redacted]' })
})

test('an END marker without its BEGIN (a window cut through a key) redacts the key body before it', () => {
  const body = Array.from(
    { length: 20 },
    (_, i) => `MIIEvQIBADANBgkqhkiG9w0BAQEFAASCBKcwggSjAgEAAoIBAQC${i}`,
  ).join('\n')
  const out = redact(`${body}\n-----END PRIVATE KEY-----\nbuild ok`)
  expect(out).not.toContain('MIIEvQIBADANBgkqhkiG9w0BAQEF')
  expect(out).toContain('build ok')
})

test('a one-time pairing link is redacted wherever it appears (audit wave 4)', () => {
  const line =
    'Pair this browser: https://10.1.1.199:8741/pair#Da0Gmy9rFhPsr7zmsUDZ35bY_yjEojaIvmx2Yy-IOdc'
  expect(redact(line)).toBe('Pair this browser: https://10.1.1.199:8741/pair#[redacted]')
})

test('MCP tokens are redacted from nested hook payloads and survive truncation order', () => {
  const token = `scm_${'k'.repeat(43)}`
  expect(
    JSON.stringify(redactValue({ output: `curl -H x ${token}`, nested: [token] })),
  ).not.toContain('scm_')
  expect(redactBounded(`${'a'.repeat(10)} ${token}`, 20)).not.toContain('scm_k')
})
