import { expect, test } from 'vitest'
import {
  readRun,
  runStatusObservation,
  translateRunEvent,
} from '../../../../src/hermes/live/translate.ts'
import { fixture } from './fake-gateway.ts'
import { admittedMessage, env, installTranslateHooks, replyMessage } from './translate-helpers.ts'

installTranslateHooks()

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
