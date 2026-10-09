import { rmSync } from 'node:fs'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { reserveMessageRun } from '../../../../src/domain/message-runs.ts'
import { insertRoom, messageFromRow, storeMessage } from '../../../../src/domain/rooms.ts'
import { messageTurnId } from '../../../../src/domain/routing.ts'
import {
  readRun,
  runSummary,
  runStatusObservation,
  translateRunEvent,
} from '../../../../src/hermes/live/translate.ts'
import { fixture } from './fake-gateway.ts'
import { setup } from './helpers.ts'

let env: ReturnType<typeof setup>
beforeEach(() => {
  env = setup()
})
afterEach(async () => {
  await env.ingest.close()
  env.db.close()
  rmSync(env.home, { recursive: true, force: true })
})

async function admitted() {
  const { runId } = await env.intents.startRunIntent(
    { profile: 'builder', input: 'fixture' },
    'fixture-turn',
  )
  return { profile: 'builder', runId, credentialGeneration: 1 }
}

test.each(['l2', 'l4a'] as const)(
  '%s replay pairs tools, resolves waiting and commits validated drafts and tokens',
  async (name) => {
    const context = await admitted()
    const metrics = { unknownEvents: 0 }
    const events = fixture(name)
    const statuses: string[] = []
    for (const event of events) {
      await env.ingest.submit(
        translateRunEvent(context, { ...event, run_id: context.runId }, metrics),
      )
      if (event.event === 'approval.request')
        expect(readRun(env.db.sqlite, context.runId).status).toBe('waiting_for_approval')
      if (event.event === 'approval.responded' || event.event === 'tool.completed')
        expect(readRun(env.db.sqlite, context.runId).status).toBe('running')
      statuses.push(readRun(env.db.sqlite, context.runId).status)
    }
    const tools = env.db.sqlite.prepare('SELECT * FROM tool_calls ORDER BY seq').all()
    const starts = events.filter((event) => event.event === 'tool.started')
    const completions = events.filter((event) => event.event === 'tool.completed')
    expect(tools).toHaveLength(starts.length)
    for (const [index, tool] of tools.entries()) {
      expect(tool).toMatchObject({
        seq: starts[index]!.seq,
        tool: starts[index]!.tool,
        status: completions[index]!.error ? 'error' : 'ok',
        duration_ms: Math.round(Number(completions[index]!.duration) * 1000),
      })
      expect(String(tool.result_preview).length).toBeLessThanOrEqual(500)
    }
    expect(runSummary(env.db.sqlite, context.runId)).toMatchObject({
      status: 'completed',
      toolsUsed: ['terminal'],
      tokens: name === 'l2' ? { input: 51481, output: 143 } : { input: 38465, output: 202 },
    })
    expect(statuses).toContain('waiting_for_approval')
    expect(
      env.db.sqlite.prepare("SELECT count(*) AS n FROM events WHERE type = 'log.line'").get()?.n,
    ).toBe(starts.length + completions.length + 1)
    expect(
      env.db.sqlite.prepare('SELECT cursor, incarnation FROM ingest_checkpoints').get(),
    ).toEqual({ cursor: String(events.at(-1)!.seq), incarnation: 'builder:g1' })
    expect(env.db.sqlite.prepare('SELECT * FROM tool_calls').all()).toEqual(tools)
    for (const event of events)
      expect(
        await env.ingest.submit(
          translateRunEvent(context, { ...event, run_id: context.runId }, metrics),
        ),
      ).toEqual({ status: 'duplicate' })
    expect(env.db.sqlite.prepare('SELECT * FROM tool_calls ORDER BY seq').all()).toEqual(tools)
    expect(metrics.unknownEvents).toBe(0)
  },
)

test('unknown and text events advance the cursor, produce no drafts and count unknown once', async () => {
  const context = await admitted()
  const metrics = { unknownEvents: 0 }
  const unknown = {
    event: 'future.feature',
    seq: 0,
    timestamp: 1791290587,
    run_id: context.runId,
    token: 'never-store-this',
  }
  const before = env.db.sqlite.prepare('SELECT * FROM events').all()
  await env.ingest.submit(translateRunEvent(context, unknown, metrics))
  await env.ingest.submit(translateRunEvent(context, unknown, metrics))
  await env.ingest.submit(
    translateRunEvent(
      context,
      { ...unknown, event: 'message.delta', delta: 'ignored without a room mapping', seq: 1 },
      metrics,
    ),
  )
  expect(metrics.unknownEvents).toBe(1)
  expect(env.db.sqlite.prepare('SELECT * FROM events').all()).toEqual(before)
  expect(readRun(env.db.sqlite, context.runId)).toMatchObject({
    last_seq: 1,
    status: 'queued',
    version: 0,
  })
  expect(env.db.sqlite.prepare('SELECT cursor FROM ingest_checkpoints').get()?.cursor).toBe('1')
})

test('older observations and newer delayed tools cannot regress terminal state', async () => {
  const context = await admitted()
  const metrics = { unknownEvents: 0 }
  const base = { run_id: context.runId, timestamp: 1791290587, tool: 'terminal', preview: 'ls' }
  await env.ingest.submit(
    translateRunEvent(
      context,
      { ...base, event: 'run.completed', seq: 10, output: 'done' },
      metrics,
    ),
  )
  const terminal = readRun(env.db.sqlite, context.runId)
  for (const seq of [2, 11])
    await env.ingest.submit(
      translateRunEvent(context, { ...base, event: 'tool.started', seq }, metrics),
    )
  await env.ingest.submit(
    translateRunEvent(context, { ...base, event: 'run.failed', seq: 12, error: 'late' }, metrics),
  )
  expect(readRun(env.db.sqlite, context.runId)).toEqual(terminal)
  expect(env.db.sqlite.prepare('SELECT * FROM tool_calls').all()).toEqual([])
  expect(env.db.sqlite.prepare('SELECT cursor FROM ingest_checkpoints').get()?.cursor).toBe('12')
})

test('parallel calls of one tool complete in call order: a completion closes the oldest running call of that name', async () => {
  const context = await admitted()
  const metrics = { unknownEvents: 0 }
  const base = { run_id: context.runId, timestamp: 1791290587, tool: 'terminal', preview: 'ls' }
  for (const seq of [0, 1])
    await env.ingest.submit(
      translateRunEvent(context, { ...base, seq, event: 'tool.started' }, metrics),
    )
  await env.ingest.submit(
    translateRunEvent(
      context,
      { ...base, seq: 2, event: 'tool.completed', duration: 0.123, error: false },
      metrics,
    ),
  )
  expect(env.db.sqlite.prepare('SELECT seq, status FROM tool_calls ORDER BY seq').all()).toEqual([
    { seq: 0, status: 'ok' },
    { seq: 1, status: 'running' },
  ])
  // A succeeded, B failed: each result lands on its own call.
  await env.ingest.submit(
    translateRunEvent(
      context,
      { ...base, seq: 3, event: 'tool.completed', duration: 0.5, error: true },
      metrics,
    ),
  )
  expect(env.db.sqlite.prepare('SELECT seq, status FROM tool_calls ORDER BY seq').all()).toEqual([
    { seq: 0, status: 'ok' },
    { seq: 1, status: 'error' },
  ])
})

test('redacts before truncating tools, approvals, terminal output and error', async () => {
  const context = await admitted()
  const metrics = { unknownEvents: 0 }
  const base = { run_id: context.runId, timestamp: 1791290587 }
  const secret = 'sk-abcdefghijklmnopqrstuv'
  const long = 'x'.repeat(490) + ` ${secret}`
  const values = [
    { event: 'tool.started', tool: 'terminal', preview: `TOKEN=${secret}` },
    {
      event: 'approval.request',
      request_id: 'redaction-request',
      choices: ['once', 'deny'],
      command: `Bearer ${secret}`,
      description: 'why',
      token: secret,
    },
    { event: 'tool.completed', tool: 'terminal', preview: long, duration: 2, error: true },
    { event: 'run.failed', output: '🐈'.repeat(2047) + ` ${secret}`, error: `password=${secret}` },
  ]
  for (const [seq, value] of values.entries())
    await env.ingest.submit(translateRunEvent(context, { ...base, ...value, seq }, metrics))
  const row = readRun(env.db.sqlite, context.runId)
  expect(Buffer.byteLength(row.output!)).toBeLessThanOrEqual(8192)
  expect(row.error).toContain('[redacted]')
  expect(JSON.stringify(env.db.sqlite.prepare('SELECT * FROM tool_calls').all())).not.toContain(
    secret,
  )
  expect(JSON.stringify(env.db.sqlite.prepare('SELECT * FROM events').all())).not.toContain(secret)
})

test('rejects malformed known events and wrong run before projection or cursor writes', async () => {
  const context = await admitted()
  const metrics = { unknownEvents: 0 }
  expect(() =>
    translateRunEvent(
      context,
      { event: 'tool.completed', run_id: context.runId, timestamp: 1791290587, seq: 0 },
      metrics,
    ),
  ).toThrow()
  expect(() =>
    translateRunEvent(
      context,
      { event: 'future', run_id: 'different', timestamp: 1791290587, seq: 0 },
      metrics,
    ),
  ).toThrow('different run')
  expect(env.db.sqlite.prepare('SELECT * FROM ingest_checkpoints').all()).toEqual([])
})

test('exact request ids survive redaction; feature gating and supplied expiry appear in the stream', async () => {
  const context = await admitted()
  const event = fixture('l4a').find((entry) => entry.event === 'approval.request')!
  const expires = Date.now() + 60_000
  await env.ingest.submit(
    translateRunEvent(
      { ...context, getDisabled: () => ['score-runs'] },
      {
        ...event,
        run_id: context.runId,
        request_id: 'sk-request-exact-aaaaaaaa',
        timestamp: Date.now() / 1000,
        command: 'echo password=must-redact',
        expires_at: expires / 1000,
      },
      { unknownEvents: 0 },
    ),
  )
  const approval = JSON.parse(
    String(
      env.db.sqlite.prepare(`SELECT data FROM events WHERE type = 'approval.requested'`).get()!
        .data,
    ),
  )
  expect(approval).toMatchObject({
    actionable: false,
    expiresAt: new Date(expires).toISOString(),
    command: 'echo password=[redacted]',
  })
  expect(env.db.sqlite.prepare('SELECT request_id FROM approvals').get()?.request_id).toBe(
    'sk-request-exact-aaaaaaaa',
  )
})

async function admittedMessage() {
  await env.ingest.submit({
    source: 'test',
    identity: 'room-message',
    apply({ sqlite, now }) {
      insertRoom(
        sqlite,
        { id: 'chat', name: '#chat', kind: 'room', leadAgentId: 'builder', members: ['builder'] },
        now,
      )
      const drafts = storeMessage(
        sqlite,
        {
          id: 'human',
          roomId: 'chat',
          author: { kind: 'you' },
          to: [],
          parts: [{ kind: 'text', text: 'fixture' }],
          refs: [],
          streaming: false,
          createdAt: now,
        },
        now,
      )
      reserveMessageRun(
        sqlite,
        {
          parentMessageId: 'human',
          roomId: 'chat',
          agentId: 'builder',
          chainId: 'human',
          hop: 0,
          input: 'fixture',
          agents: ['builder', 'reviewer'],
        },
        now,
      )
      return drafts
    },
  })
  const { runId } = await env.intents.startRunIntent(
    { profile: 'builder', input: 'fixture' },
    messageTurnId('human', 'builder'),
  )
  return { profile: 'builder', runId, credentialGeneration: 1 }
}
const replyMessage = () =>
  messageFromRow(env.db.sqlite.prepare("SELECT * FROM messages WHERE author_kind = 'agent'").get())

test.each(['l2', 'l4a'] as const)(
  '%s streams recorded deltas into one mapped reply without repeating interim text',
  async (name) => {
    const context = await admittedMessage()
    const initial = replyMessage()
    expect(initial).toMatchObject({
      streaming: true,
      parts: [],
      refs: [{ kind: 'run', runId: context.runId }],
    })
    const recorded = fixture(name)
    for (const event of recorded)
      await env.ingest.submit(
        translateRunEvent(context, { ...event, run_id: context.runId }, { unknownEvents: 0 }),
      )
    const reply = replyMessage()
    const text = recorded
      .filter((event) => event.event === 'message.delta')
      .map((event) => event.delta)
      .join('')
    expect(reply).toMatchObject({ id: initial.id, streaming: false })
    expect(reply.parts.find((part) => part.kind === 'text')).toEqual({ kind: 'text', text })
    // Each call became a tool card in Hermes order (PLAN 5.25); the compact summary is only for old messages.
    const cards = reply.parts.filter((part) => part.kind === 'tool')
    expect(cards.length).toBeGreaterThan(0)
    expect(cards.every((part) => part.tool.length > 0 && part.status !== 'running')).toBe(true)
    expect(reply.parts.some((part) => part.kind === 'tools')).toBe(false)
    // Unsettled text is held back, so some deltas emit nothing until a later one settles them.
    const emitted = Number(
      env.db.sqlite.prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'message.delta'").get()
        ?.n,
    )
    expect(emitted).toBeGreaterThan(0)
    expect(emitted).toBeLessThanOrEqual(
      recorded.filter((event) => event.event === 'message.delta').length,
    )
    expect(
      env.db.sqlite
        .prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'message.completed'")
        .get()?.n,
    ).toBe(1)
    for (const event of recorded)
      await env.ingest.submit(
        translateRunEvent(context, { ...event, run_id: context.runId }, { unknownEvents: 0 }),
      )
    expect(replyMessage()).toEqual(reply)
  },
)

test('non-streamed interim and recovered terminal output are redacted, with no hand-off on failure', async () => {
  const context = await admittedMessage()
  const base = { run_id: context.runId, timestamp: 1791290587 }
  await env.ingest.submit(
    translateRunEvent(
      context,
      {
        ...base,
        event: 'message.interim',
        seq: 0,
        text: 'password=hide-this @reviewer',
        already_streamed: false,
      },
      { unknownEvents: 0 },
    ),
  )
  // The last word could still grow, so it is held until the run ends.
  expect(replyMessage().parts).toEqual([{ kind: 'text', text: 'password=[redacted] ' }])
  await env.ingest.submit(
    translateRunEvent(
      context,
      { ...base, event: 'run.failed', seq: 1, output: 'duplicate' },
      { unknownEvents: 0 },
    ),
  )
  expect(replyMessage()).toMatchObject({
    streaming: false,
    parts: [
      { kind: 'text', text: 'password=[redacted] @reviewer' },
      { kind: 'text', text: 'This run failed' },
    ],
  })
  expect(env.db.sqlite.prepare('SELECT COUNT(*) AS n FROM message_runs').get()?.n).toBe(1)
})

test('terminal status polling fills an empty reply and completes it in the same transaction', async () => {
  const context = await admittedMessage()
  const run = await env.gateway.getRun('builder', context.runId)
  await env.ingest.submit(
    runStatusObservation(context, { ...run, status: 'completed', output: 'secret=hidden done' }),
  )
  expect(replyMessage()).toMatchObject({
    streaming: false,
    parts: [{ kind: 'text', text: 'secret=[redacted] done' }],
  })
})

test('failed delta projection rolls back its text and checkpoint together', async () => {
  const context = await admittedMessage()
  const observation = translateRunEvent(
    context,
    {
      run_id: context.runId,
      timestamp: 1791290587,
      event: 'message.delta',
      seq: 0,
      delta: 'hello ',
    },
    { unknownEvents: 0 },
  )
  await expect(
    env.ingest.submit({
      ...observation,
      apply(ctx) {
        observation.apply(ctx)
        throw new Error('rollback')
      },
    }),
  ).rejects.toThrow('rollback')
  expect(replyMessage().parts).toEqual([])
  expect(env.db.sqlite.prepare('SELECT pending FROM message_runs').get()?.pending).toBe('')
  expect(readRun(env.db.sqlite, context.runId).last_seq).toBeNull()
  expect(env.db.sqlite.prepare('SELECT * FROM ingest_checkpoints').all()).toEqual([])
  await env.ingest.submit(observation)
  expect(replyMessage().parts).toEqual([{ kind: 'text', text: 'hello ' }])
})

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

test('a reply cut short (restart, lost replay) is completed from the final output, and its hand-off still happens', async () => {
  const context = await admittedMessage()
  const base = { run_id: context.runId, timestamp: Date.now() / 1000 }
  const events = [
    { ...base, event: 'message.delta', delta: 'I have completed ', seq: 1 },
    // Deltas for "the work. @reviewer please check." never arrived (audit 2026-10-08).
    {
      ...base,
      event: 'run.completed',
      output: 'I have completed the work. @reviewer please check.',
      completed: true,
      partial: false,
      interrupted: false,
      seq: 9,
    },
  ]
  for (const event of events)
    await env.ingest.submit(translateRunEvent(context, event, { unknownEvents: 0 }))
  expect(replyMessage()).toMatchObject({
    streaming: false,
    parts: [{ kind: 'text', text: 'I have completed the work. @reviewer please check.' }],
  })
  const reviewer = env.db.sqlite
    .prepare("SELECT agent_id, hop FROM message_runs WHERE agent_id = 'reviewer'")
    .get()
  expect(reviewer).toMatchObject({ agent_id: 'reviewer', hop: 1 })
})

test('when the final output does not continue the streamed text, the streamed text is kept as is', async () => {
  const context = await admittedMessage()
  const base = { run_id: context.runId, timestamp: Date.now() / 1000 }
  for (const event of [
    { ...base, event: 'message.delta', delta: 'Working on it. ', seq: 1 },
    { ...base, event: 'run.completed', output: 'Different summary.', completed: true, seq: 2 },
  ])
    await env.ingest.submit(translateRunEvent(context, event, { unknownEvents: 0 }))
  expect(replyMessage().parts).toEqual([{ kind: 'text', text: 'Working on it. ' }])
})

test('a failed run leaves a visible notice with the sanitized error in the reply', async () => {
  const context = await admittedMessage()
  await env.ingest.submit(
    translateRunEvent(
      context,
      {
        run_id: context.runId,
        timestamp: 1791290587,
        event: 'run.failed',
        seq: 1,
        error: 'provider auth failed token=abc123secret',
      },
      { unknownEvents: 0 },
    ),
  )
  const text = JSON.stringify(replyMessage().parts)
  expect(text).toContain('This run failed: ')
  expect(text).not.toContain('abc123secret')
})

test('output that diverges after a restart lost held text replaces the streamed text and hands off', async () => {
  const context = await admittedMessage()
  const base = { run_id: context.runId, timestamp: Date.now() / 1000 }
  await env.ingest.submit(
    translateRunEvent(
      context,
      { ...base, event: 'message.delta', delta: 'Done. @rev', seq: 1 },
      { unknownEvents: 0 },
    ),
  )
  // The held "@rev" was sealed by the previous process: simulate it with an unreadable value.
  env.db.sqlite
    .prepare("UPDATE message_runs SET pending = 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA'")
    .run()
  const output = 'Done. @reviewer please review.'
  for (const event of [
    { ...base, event: 'message.delta', delta: 'iewer please review.', seq: 2 },
    { ...base, event: 'run.completed', output, seq: 3 },
  ])
    await env.ingest.submit(translateRunEvent(context, event, { unknownEvents: 0 }))
  expect(replyMessage().parts).toEqual([{ kind: 'text', text: output }])
  expect(
    env.db.sqlite.prepare("SELECT hop FROM message_runs WHERE agent_id = 'reviewer'").get(),
  ).toMatchObject({ hop: 1 })
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

test('reasoning and tool calls become redacted, bounded cards on the finished reply (PLAN 5.25)', async () => {
  const context = await admittedMessage()
  const secret = 'sk-' + 'a1b2c3d4e5f6a7b8c9d0e1f2a3b4c5'
  const base = { run_id: context.runId, timestamp: 1 }
  const events = [
    { ...base, event: 'reasoning.available', seq: 1, text: `use the key ${secret} carefully` },
    {
      ...base,
      event: 'tool.started',
      seq: 2,
      tool: 'terminal',
      preview: `curl -H "Authorization: Bearer ${secret}" x`,
    },
    {
      ...base,
      event: 'tool.completed',
      seq: 3,
      tool: 'terminal',
      preview: 'x'.repeat(900),
      duration: 0.2,
      error: true,
    },
    { ...base, event: 'message.delta', seq: 4, delta: 'Done.' },
    {
      ...base,
      event: 'run.completed',
      seq: 5,
      output: 'Done.',
      usage: { input_tokens: 5, output_tokens: 2 },
    },
  ]
  for (const event of events)
    await env.ingest.submit(translateRunEvent(context, event, { unknownEvents: 0 }))
  const reply = replyMessage()
  expect(reply.parts.map((part) => part.kind)).toEqual(['thinking', 'tool', 'text'])
  const [thinking, tool] = reply.parts
  expect(JSON.stringify(reply.parts)).not.toContain(secret)
  expect(thinking).toMatchObject({ kind: 'thinking' })
  expect(tool).toMatchObject({ kind: 'tool', tool: 'terminal', status: 'error' })
  if (tool?.kind === 'tool') expect(tool.result!.length).toBeLessThanOrEqual(500)
})

test('more than 30 tool calls keep the compact summary after the first 30 cards (PLAN 5.25)', async () => {
  const context = await admittedMessage()
  const base = { run_id: context.runId, timestamp: 1 }
  let seq = 1
  for (let call = 0; call < 32; call++) {
    await env.ingest.submit(
      translateRunEvent(
        context,
        { ...base, event: 'tool.started', seq: seq++, tool: 'terminal', preview: `c${call}` },
        { unknownEvents: 0 },
      ),
    )
    await env.ingest.submit(
      translateRunEvent(
        context,
        {
          ...base,
          event: 'tool.completed',
          seq: seq++,
          tool: 'terminal',
          preview: 'ok',
          duration: 0.1,
          error: false,
        },
        { unknownEvents: 0 },
      ),
    )
  }
  await env.ingest.submit(
    translateRunEvent(
      context,
      { ...base, event: 'run.completed', seq: seq, output: 'ok' },
      { unknownEvents: 0 },
    ),
  )
  const reply = replyMessage()
  expect(reply.parts.filter((part) => part.kind === 'tool')).toHaveLength(30)
  expect(reply.parts.some((part) => part.kind === 'tools')).toBe(true)
})

test('a streaming reply’s progress clock moves with tools, reasoning and text, and ends with the reply', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  try {
    vi.setSystemTime(new Date('2030-10-09T10:00:00.000Z'))
    // The ingest pipeline took Date.now when it was built, so build a fresh one on the fake clock.
    await env.ingest.close()
    env.db.close()
    rmSync(env.home, { recursive: true, force: true })
    env = setup()
    const context = await admittedMessage()
    const progress = () => replyMessage().progressAt
    const progressedEvents = () =>
      Number(
        env.db.sqlite
          .prepare("SELECT COUNT(*) AS n FROM events WHERE type = 'message.progressed'")
          .get()?.n,
      )
    const send = (seq: number, minutes: number, body: object) => {
      vi.setSystemTime(new Date(Date.parse('2030-10-09T10:00:00.000Z') + minutes * 60_000))
      return env.ingest.submit(
        translateRunEvent(
          context,
          { seq, timestamp: 1791290600 + seq, run_id: context.runId, ...body },
          { unknownEvents: 0 },
        ),
      )
    }
    expect(progress()).toBe('2030-10-09T10:00:00.000Z')
    await send(1, 1, { event: 'tool.started', tool: 'terminal', preview: 'ls' })
    expect(progress()).toBe('2030-10-09T10:01:00.000Z')
    expect(progressedEvents()).toBe(1)
    await send(2, 2, { event: 'reasoning.available', text: 'thinking' })
    expect(progress()).toBe('2030-10-09T10:02:00.000Z')
    expect(progressedEvents()).toBe(2)
    // Text moves the clock but is announced by message.delta, not message.progressed.
    await send(3, 3, { event: 'message.delta', delta: 'Hello ' })
    expect(progress()).toBe('2030-10-09T10:03:00.000Z')
    expect(progressedEvents()).toBe(2)
    await send(4, 4, { event: 'run.completed', output: 'Hello there' })
    expect(replyMessage().streaming).toBe(false)
    expect(replyMessage().progressAt).toBeUndefined()
  } finally {
    vi.useRealTimers()
  }
})
