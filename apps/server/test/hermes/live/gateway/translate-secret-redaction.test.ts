import { expect, test } from 'vitest'
import { translateRunEvent } from '../../../../src/hermes/live/translate.ts'
import { admittedMessage, env, installTranslateHooks, replyMessage } from './translate-helpers.ts'

installTranslateHooks()

const delta = (seq: number, text: string) => ({
  run_id: '',
  timestamp: 1791290587,
  event: 'message.delta',
  seq,
  delta: text,
})
test.each([
  ['a token split mid-word', ['Your key is sk-or-ab', 'cdef1234567890 and more.']],
  [
    'a bearer label split from its value',
    ['Send Authorization: Bearer', ' eyJhbGciOiJIUzI1NiJ9.e30.abc then go.'],
  ],
  [
    'a key/value split after the colon',
    ['config:\napi_key: ', 'Zx9vQ2mL7pR4tY8wE1uI3oP6aS5dF0gH\nok.'],
  ],
  [
    'a quoted password split inside the quotes',
    ['password = "correct horse', ' battery staple" done.'],
  ],
  [
    'a private key over many chunks',
    [
      'Here:\n-----BEGIN PRIVATE',
      ' KEY-----\nMIIEvQIBADANBgkq\n',
      'hkiG9w0BAQEFAASC\n-----END PRIVATE KEY-----\nDone.',
    ],
  ],
])('%s never reaches the stored reply or the events log', async (_name, chunks) => {
  const context = await admittedMessage()
  for (const [seq, text] of chunks.entries())
    await env.ingest.submit(
      translateRunEvent(
        context,
        { ...delta(seq, text), run_id: context.runId },
        { unknownEvents: 0 },
      ),
    )
  await env.ingest.submit(
    translateRunEvent(
      context,
      {
        run_id: context.runId,
        timestamp: 1791290587,
        event: 'run.completed',
        seq: chunks.length,
        output: null,
      },
      { unknownEvents: 0 },
    ),
  )
  const stored = JSON.stringify(replyMessage().parts)
  const events = JSON.stringify(env.db.sqlite.prepare('SELECT data FROM events').all())
  for (const secret of [
    'cdef1234567890',
    'eyJhbGciOiJIUzI1NiJ9',
    'Zx9vQ2mL7pR4tY8wE1uI3oP6aS5dF0gH',
    'battery',
    'MIIEvQIBADANBgkq',
    'hkiG9w0BAQEFAASC',
  ]) {
    expect(stored).not.toContain(secret)
    expect(events).not.toContain(secret)
  }
  expect(stored).toContain('[redacted]')
  // Held text is sealed at rest, never stored raw.
  expect(env.db.sqlite.prepare('SELECT pending FROM message_runs').get()?.pending).toBe('')
})

test('held text is sealed in the database while the run streams', async () => {
  const context = await admittedMessage()
  await env.ingest.submit(
    translateRunEvent(
      context,
      { ...delta(0, 'token: sk-or-abcdef12345678'), run_id: context.runId },
      { unknownEvents: 0 },
    ),
  )
  const pending = String(env.db.sqlite.prepare('SELECT pending FROM message_runs').get()?.pending)
  expect(pending).not.toBe('')
  expect(pending).not.toContain('sk-or')
  expect(replyMessage().parts).toEqual([])
})

test('a token streamed after a restart lost its "Bearer " label never reaches the events log', async () => {
  const context = await admittedMessage()
  const base = { run_id: context.runId, timestamp: Date.now() / 1000 }
  await env.ingest.submit(
    translateRunEvent(
      context,
      { ...base, event: 'message.delta', delta: 'Send Authorization: Bearer ', seq: 1 },
      { unknownEvents: 0 },
    ),
  )
  env.db.sqlite
    .prepare("UPDATE message_runs SET pending = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'")
    .run()
  const token = 'Zx9vQ2mLpR4tY8wE1uI3oP6aS5dF0gHjKlMn'
  for (const event of [
    { ...base, event: 'message.delta', delta: `${token}\nnext`, seq: 2 },
    {
      ...base,
      event: 'run.completed',
      output: `Send Authorization: Bearer ${token}\nnext`,
      seq: 3,
    },
  ])
    await env.ingest.submit(translateRunEvent(context, event, { unknownEvents: 0 }))
  const logged = JSON.stringify(env.db.sqlite.prepare('SELECT * FROM events').all())
  expect(logged).not.toContain(token)
})

const eventsText = () =>
  JSON.stringify(env.db.sqlite.prepare("SELECT data FROM events WHERE type LIKE 'message.%'").all())

test('a known gateway key split across two deltas never reaches the reply or the events log (gate 2026-10-09)', async () => {
  const { registerKnownSecret } = await import('../../../../src/redact.ts')
  const key = 'a3f1c9e07b5d42e88f60c1b2d3e4f5a6'
  registerKnownSecret(key)
  const context = await admittedMessage()
  const base = { run_id: context.runId, timestamp: Date.now() / 1000 }
  for (const event of [
    { ...base, event: 'message.delta', delta: `The key is ${key.slice(0, 13)}`, seq: 1 },
    { ...base, event: 'message.delta', delta: `${key.slice(13)} so keep it safe. `, seq: 2 },
    {
      ...base,
      event: 'run.completed',
      output: `The key is ${key} so keep it safe.`,
      completed: true,
      seq: 3,
    },
  ])
    await env.ingest.submit(translateRunEvent(context, event, { unknownEvents: 0 }))
  const stored = JSON.stringify(replyMessage())
  expect(stored).not.toContain(key)
  expect(stored).not.toContain(key.slice(0, 13))
  expect(eventsText()).not.toContain(key.slice(0, 13))
  expect(eventsText()).not.toContain(key.slice(13))
})

test('an unterminated key block past the hold limit publishes none of its body, then or later (gate 2026-10-09)', async () => {
  const context = await admittedMessage()
  const base = { run_id: context.runId, timestamp: Date.now() / 1000 }
  const body = Array.from(
    { length: 320 },
    (_, i) => `QUJDREVGR0hJSktMTU5PUFFSU1RVVldYWVo${String(i).padStart(4, '0')}abcdefghijk`,
  )
  const events = [
    {
      ...base,
      event: 'message.delta',
      delta: 'Here it is:\n-----BEGIN PRIVATE KEY-----\n',
      seq: 1,
    },
    ...body.map((line, i) => ({ ...base, event: 'message.delta', delta: `${line}\n`, seq: i + 2 })),
  ]
  for (const event of events)
    await env.ingest.submit(translateRunEvent(context, event, { unknownEvents: 0 }))
  const midway = JSON.stringify(replyMessage()) + eventsText()
  for (const line of body) expect(midway).not.toContain(line.slice(0, 40))
  await env.ingest.submit(
    translateRunEvent(
      context,
      {
        ...base,
        event: 'run.completed',
        output: `Here it is:\n-----BEGIN PRIVATE KEY-----\n${body.join('\n')}\n-----END PRIVATE KEY-----\nDone.`,
        completed: true,
        seq: 999,
      },
      { unknownEvents: 0 },
    ),
  )
  const final = JSON.stringify(replyMessage()) + eventsText()
  for (const line of body) expect(final).not.toContain(line.slice(0, 40))
  expect(replyMessage().streaming).toBe(false)
})
