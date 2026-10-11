import { BridgeCommandsResponseSchema } from '@score/contract'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { RewindBroker } from '../../../src/hermes/bridge/rewind-broker.ts'
import { hello, setup } from './helpers.ts'

let env: ReturnType<typeof setup>
let broker: RewindBroker
beforeEach(() => {
  broker = new RewindBroker()
  env = setup({ rewind: broker })
})
afterEach(async () => {
  await env.close()
})
const poll = (token: string, wait = 0) =>
  env.app.inject({
    method: 'GET',
    url: `/bridge/v1/commands?wait=${wait}`,
    headers: env.headers(token),
  })
const result = (token: string, commandId: string, payload: object) =>
  env.app.inject({
    method: 'POST',
    url: `/bridge/v1/commands/${commandId}/result`,
    headers: env.headers(token),
    payload,
  })

test('a rewind command round trip: poll, run, result; delivered once', async () => {
  const token = await env.token()
  // Not listening yet: nothing can be asked.
  expect(await broker.request('builder', { sessionId: 's', turns: 1 }, 50)).toEqual({
    status: 'unavailable',
  })
  expect((await poll(token)).json()).toEqual({ items: [] })
  const asked = broker.request('builder', { sessionId: 'score-room-builder', turns: 2 }, 5000)
  const first = BridgeCommandsResponseSchema.parse((await poll(token, 5)).json())
  expect(first.items).toEqual([
    {
      commandId: expect.any(String),
      kind: 'rewind',
      sessionId: 'score-room-builder',
      turns: 2,
      // Issued now + the time the request waits: the plugin refuses it after that.
      expiresAt: expect.closeTo(Date.now() / 1000 + 5, 1),
    },
  ])
  expect((await poll(token)).json()).toEqual({ items: [] })
  expect(
    (
      await result(token, first.items[0]!.commandId, {
        outcome: 'done',
        turnsUndone: 2,
        rewoundCount: 5,
      })
    ).statusCode,
  ).toBe(204)
  expect(await asked).toEqual({ status: 'done', turnsUndone: 2, rewoundCount: 5 })
})

test('a long poll wakes when a command arrives', async () => {
  const token = await env.token()
  expect((await poll(token)).statusCode).toBe(200)
  const waiting = poll(token, 5)
  const asked = broker.request('builder', { sessionId: 's', turns: 1 }, 5000)
  const items = BridgeCommandsResponseSchema.parse((await waiting).json()).items
  expect(items).toHaveLength(1)
  await result(token, items[0]!.commandId, { outcome: 'nothing' })
  expect(await asked).toEqual({ status: 'nothing' })
})

test("commands go only to the profile's own producer and never to one that cannot tell where it runs", async () => {
  const builder = await env.token()
  const other = await env.token({ ...hello, profile: 'reviewer', incarnation: 'worker-reviewer' })
  const blind = await env.token({
    ...hello,
    profile: 'lead',
    incarnation: 'worker-lead-x',
    isolation: 'unknown',
  })
  await poll(builder)
  await poll(other)
  await poll(blind)
  expect(await broker.request('lead', { sessionId: 's', turns: 1 }, 50)).toEqual({
    status: 'unavailable',
  })
  const asked = broker.request('builder', { sessionId: 's', turns: 1 }, 5000)
  expect((await poll(other)).json()).toEqual({ items: [] })
  const items = BridgeCommandsResponseSchema.parse((await poll(builder)).json()).items
  // Another profile can't answer it either.
  await result(other, items[0]!.commandId, { outcome: 'done', turnsUndone: 1, rewoundCount: 1 })
  await result(builder, items[0]!.commandId, { outcome: 'failed', error: 'x' })
  expect(await asked).toEqual({ status: 'failed', error: 'x' })
})

test('an unanswered command ends as no_answer and is not run later', async () => {
  const token = await env.token()
  await poll(token)
  const asked = await broker.request('builder', { sessionId: 's', turns: 1 }, 20)
  expect(asked).toEqual({ status: 'no_answer' })
  expect((await poll(token)).json()).toEqual({ items: [] })
})

test('commands need a producer token', async () => {
  expect((await poll('x'.repeat(43))).statusCode).toBe(401)
})

test('the plugin may report a command as expired', async () => {
  const token = await env.token()
  await poll(token)
  const asked = broker.request('builder', { sessionId: 's', turns: 1 }, 5000)
  const items = BridgeCommandsResponseSchema.parse((await poll(token, 5)).json()).items
  expect((await result(token, items[0]!.commandId, { outcome: 'expired' })).statusCode).toBe(204)
  expect(await asked).toEqual({ status: 'expired' })
})

test('PLAN 5.36: compact and context_breakdown commands carry their payloads through the broker', async () => {
  const token = await env.token()
  expect((await poll(token)).statusCode).toBe(200)
  const compact = broker.ask(
    'builder',
    { kind: 'compact', sessionId: 'score-r-builder', keepRecent: 3 },
    5000,
  )
  const first = BridgeCommandsResponseSchema.parse((await poll(token, 5)).json()).items
  expect(first).toEqual([
    {
      commandId: expect.any(String),
      kind: 'compact',
      sessionId: 'score-r-builder',
      keepRecent: 3,
      expiresAt: expect.any(Number),
    },
  ])
  await result(token, first[0]!.commandId, {
    outcome: 'done',
    before: { messages: 40, tokens: 54000 },
    after: { messages: 8, tokens: 9000 },
  })
  expect(await compact).toEqual({
    status: 'done',
    turnsUndone: 0,
    rewoundCount: 0,
    before: { messages: 40, tokens: 54000 },
    after: { messages: 8, tokens: 9000 },
  })

  const failing = broker.ask('builder', { kind: 'compact', sessionId: 's' }, 5000)
  const second = BridgeCommandsResponseSchema.parse((await poll(token, 5)).json()).items
  await result(token, second[0]!.commandId, { outcome: 'failed', error: 'lock_held' })
  expect(await failing).toEqual({ status: 'failed', error: 'lock_held' })

  const context = {
    window: 128000,
    used: 30000,
    model: 'm',
    source: 'provider_usage',
    autoCompactAt: 64000,
    parts: [{ kind: 'conversation', label: 'Messages', tokens: 20000 }],
  }
  const asked = broker.ask('builder', { kind: 'context_breakdown', sessionId: 's' }, 5000)
  const third = BridgeCommandsResponseSchema.parse((await poll(token, 5)).json()).items
  expect(third[0]).toMatchObject({ kind: 'context_breakdown', sessionId: 's' })
  expect((await result(token, third[0]!.commandId, { outcome: 'done', context })).statusCode).toBe(
    204,
  )
  expect(await asked).toMatchObject({ status: 'done', context })
  // A malformed context answer is refused at the edge.
  const bad = broker.ask('builder', { kind: 'context_breakdown', sessionId: 's' }, 200)
  const fourth = BridgeCommandsResponseSchema.parse((await poll(token, 5)).json()).items
  expect(
    (await result(token, fourth[0]!.commandId, { outcome: 'done', context: { used: -1 } }))
      .statusCode,
  ).toBeGreaterThanOrEqual(400)
  expect(await bad).toEqual({ status: 'no_answer' })
})
