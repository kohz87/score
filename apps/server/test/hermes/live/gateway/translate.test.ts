import { rmSync } from 'node:fs'
import { afterEach, beforeEach, expect, test } from 'vitest'
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

test('completion selects the latest running tool with the same name', async () => {
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
    { seq: 0, status: 'running' },
    { seq: 1, status: 'ok' },
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
    expect(reply.parts[0]).toEqual({ kind: 'text', text })
    expect(reply.parts.find((part) => part.kind === 'tools')).toMatchObject({
      kind: 'tools',
      summary: expect.stringMatching(/^Ran \d+ commands?$/),
      runId: context.runId,
    })
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
    parts: [{ kind: 'text', text: 'password=[redacted] @reviewer' }],
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
