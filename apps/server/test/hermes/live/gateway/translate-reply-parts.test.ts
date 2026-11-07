import { rmSync } from 'node:fs'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { translateRunEvent } from '../../../../src/hermes/live/translate.ts'
import { setup } from './helpers.ts'
import { admittedMessageFor, replyMessageFrom, type TranslateEnv } from './translate-helpers.ts'

let env: TranslateEnv
beforeEach(() => {
  env = setup()
})
afterEach(async () => {
  await env.ingest.close()
  env.db.close()
  rmSync(env.home, { recursive: true, force: true })
})

const admittedMessage = () => admittedMessageFor(env)
const replyMessage = () => replyMessageFrom(env)

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

test('a tool call shows on the reply while it is written: running, then done, in front of the text (PLAN 5.39)', async () => {
  const context = await admittedMessage()
  const base = { run_id: context.runId, timestamp: 1 }
  const updates = () =>
    (
      env.db.sqlite
        .prepare("SELECT data FROM events WHERE type = 'message.updated' ORDER BY seq")
        .all() as { data: string }[]
    ).map(
      (row) =>
        JSON.parse(row.data) as { messageId: string; parts: { kind: string; status?: string }[] },
    )
  await env.ingest.submit(
    translateRunEvent(
      context,
      { ...base, event: 'message.delta', seq: 1, delta: 'Looking. ' },
      { unknownEvents: 0 },
    ),
  )
  expect(updates()).toEqual([])
  await env.ingest.submit(
    translateRunEvent(
      context,
      { ...base, event: 'tool.started', seq: 2, tool: 'search_changelog', preview: 'q' },
      { unknownEvents: 0 },
    ),
  )
  const reply = replyMessage()
  expect(updates().map((u) => u.parts.map((p) => `${p.kind}:${p.status ?? ''}`))).toEqual([
    ['tool:running', 'text:'],
  ])
  expect(updates()[0]!.messageId).toBe(reply.id)
  // Nothing is stored yet: the final parts are written when the reply ends.
  expect(reply.parts.map((part) => part.kind)).toEqual(['text'])
  await env.ingest.submit(
    translateRunEvent(
      context,
      {
        ...base,
        event: 'tool.completed',
        seq: 3,
        tool: 'search_changelog',
        preview: 'two',
        duration: 0.1,
        error: false,
      },
      { unknownEvents: 0 },
    ),
  )
  expect(
    updates()
      .at(-1)!
      .parts.map((p) => `${p.kind}:${p.status ?? ''}`),
  ).toEqual(['tool:ok', 'text:'])
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
