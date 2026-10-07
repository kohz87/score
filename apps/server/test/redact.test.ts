import { expect, test } from 'vitest'
import { redact, redactBounded, redactValue } from '../src/redact.ts'

const cases: [string, string][] = [
  ['Bearer fixture-token.abc', 'Bearer [redacted]'],
  ['bearer abc+xyz/=', 'Bearer [redacted]'],
  ['sk-abcdefgh12345678', '[redacted]'],
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
  ['monkey=banana tokenizer=ok secretive=yes', 'monkey=banana tokenizer=ok secretive=yes'],
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
    'session_id',
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
