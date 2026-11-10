import { AgentChatModelsSchema, ChatModelsResponseSchema, RoomSchema } from '@score/contract'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { buildApp } from '../../src/app.ts'
import { loadConfig } from '../../src/config.ts'
import { migrate, openDatabase, type ScoreDb } from '../../src/db/index.ts'
import { FakePort } from '../../src/hermes/fake/fake-port.ts'
import { createIngest, type Ingest } from '../../src/hub/ingest.ts'
import { FakeScheduler } from '../hermes/fake-scheduler.ts'

let dir: string
let db: ScoreDb
let ingest: Ingest
let port: FakePort
let scheduler: FakeScheduler
let app: ReturnType<typeof buildApp>
let headers: { 'x-score-client': string; cookie: string }
let roomId: string

beforeEach(async () => {
  dir = mkdtempSync(join(tmpdir(), 'score-chat-models-http-'))
  db = openDatabase(join(dir, 'score.db'))
  migrate(db, fileURLToPath(new URL('../../migrations/', import.meta.url)))
  scheduler = new FakeScheduler()
  const clock = () => scheduler.now()
  ingest = createIngest(db, { clock })
  port = new FakePort(1, { db, scheduler }, false, () => ({ text: 'Done.', tools: [] }))
  await port.start(ingest)
  // The script's first timer is the only one armed; dropping it keeps the demo scenario out of these tests.
  scheduler.clearTimeout(0)
  app = buildApp({
    config: loadConfig({ SCORE_MODE: 'fake' }),
    logger: false,
    db,
    ingest,
    port,
    clock,
  })
  const paired = await app.inject({
    method: 'POST',
    url: '/api/session/pair',
    headers: { 'x-score-client': 'web' },
    payload: { token: app.pairing.createToken() },
  })
  headers = {
    'x-score-client': 'web',
    cookie: paired.headers['set-cookie']!.toString().split(';')[0]!,
  }
  roomId = await room('models')
})
afterEach(async () => {
  await port.stop()
  await app.close()
  await ingest.close()
  db.close()
  rmSync(dir, { recursive: true, force: true })
  vi.restoreAllMocks()
})

let keys = 0
const post = (url: string, payload: object) =>
  app.inject({
    method: 'POST',
    url,
    headers: { ...headers, 'idempotency-key': `k${++keys}` },
    payload,
  })
const put = (agentId: string, model: string | null, provider?: string) =>
  app.inject({
    method: 'PUT',
    url: `/api/rooms/${roomId}/models/${agentId}`,
    headers: { ...headers, 'idempotency-key': `k${++keys}` },
    payload: { model, ...(provider ? { provider } : {}) },
  })
const room = async (name: string) =>
  RoomSchema.parse(
    (
      await post('/api/team-rooms', {
        name,
        members: ['lead', 'builder', 'reviewer'],
        leadAgentId: 'lead',
      })
    ).json(),
  ).id
const roomModels = async () =>
  ChatModelsResponseSchema.parse(
    (await app.inject({ method: 'GET', url: `/api/rooms/${roomId}/models`, headers })).json(),
  ).items
async function advance(ms: number) {
  await scheduler.advance(ms)
  await ingest.flushListeners()
  await ingest.drain()
}

test('a chat sets an agent’s model, lists it, answers with what it replaced, and goes back to its own', async () => {
  const set = await put('builder', 'local-gpt-mini')
  expect(set.statusCode).toBe(200)
  expect(set.json()).toEqual({
    roomId,
    agentId: 'builder',
    current: {
      roomId,
      agentId: 'builder',
      model: 'local-gpt-mini',
      provider: 'local',
      label: 'local-gpt-mini',
    },
    replaced: null,
  })
  expect(await roomModels()).toEqual([set.json().current])
  const agent = await app.inject({ method: 'GET', url: '/api/agents/builder/chat-models', headers })
  expect(AgentChatModelsSchema.parse(agent.json()).chats).toEqual([
    {
      roomId,
      roomName: 'models',
      roomKind: 'group',
      jobTitle: null,
      model: 'local-gpt-mini',
      label: 'local-gpt-mini',
    },
  ])
  const back = await put('builder', null)
  expect(back.json()).toMatchObject({ current: null, replaced: { model: 'local-gpt-mini' } })
  expect(await roomModels()).toEqual([])
})

test('an alias is resolved to its model, and the chat keeps the alias as its label', async () => {
  await port.updateModelSettings('builder', {
    aliases: [{ name: 'deep', model: 'fake-model', provider: 'local' }],
  })
  const set = await put('builder', 'deep')
  expect(set.statusCode).toBe(200)
  expect(set.json().current).toEqual({
    roomId,
    agentId: 'builder',
    model: 'fake-model',
    provider: 'local',
    label: 'deep',
  })
})

test('a model Hermes doesn’t list, an agent not in the chat, or no chat is refused', async () => {
  const unknown = await put('builder', 'no-such-model')
  expect(unknown.statusCode).toBe(400)
  expect(unknown.json().error.message).toContain('isn’t available')
  expect((await put('builder', 'bad model')).statusCode).toBe(400)
  expect((await put('nobody', 'fake-model')).statusCode).toBe(400)
  const nowhere = await app.inject({
    method: 'PUT',
    url: '/api/rooms/nope/models/builder',
    headers: { ...headers, 'idempotency-key': 'nope' },
    payload: { model: 'fake-model' },
  })
  expect(nowhere.statusCode).toBe(404)
  expect(await roomModels()).toEqual([])
})

test('changing a chat’s model needs a paired browser', async () => {
  const response = await app.inject({
    method: 'PUT',
    url: `/api/rooms/${roomId}/models/builder`,
    headers: { 'x-score-client': 'web', 'idempotency-key': 'unpaired' },
    payload: { model: 'fake-model' },
  })
  expect(response.statusCode).toBe(401)
})

test('a turn in the chat runs on its model; the agent’s own model and other chats are untouched', async () => {
  const before = (await app.inject({ method: 'GET', url: '/api/agents/builder', headers })).json()
  await put('builder', 'local-gpt-mini')
  const run = vi.spyOn(port, 'startRun')
  await post(`/api/rooms/${roomId}/messages`, { text: '@builder please look' })
  await advance(100)
  expect(run.mock.calls.map(([req]) => [req.agentId, req.model, req.provider])).toEqual([
    ['builder', 'local-gpt-mini', 'local'],
  ])
  const after = (await app.inject({ method: 'GET', url: '/api/agents/builder', headers })).json()
  expect(after.model).toEqual(before.model)
  // Another chat sends no model: the agent's own.
  const other = await room('other')
  run.mockClear()
  await post(`/api/rooms/${other}/messages`, { text: '@builder hello' })
  await advance(100)
  expect(run.mock.calls.map(([req]) => [req.agentId, req.model ?? null])).toEqual([
    ['builder', null],
  ])
})

test('pinning the repeating jobs that follow the agent keeps them on its current model', async () => {
  await port.createRoutine(
    'builder',
    { title: 'Morning', schedule: 'every 1d', prompt: 'Sum up.' },
    'r1',
  )
  const pinned = await post('/api/agents/builder/routines/pin', {})
  expect(pinned.statusCode).toBe(200)
  expect(pinned.json().pinned).toHaveLength(1)
  const list = (
    await app.inject({ method: 'GET', url: '/api/agents/builder/routines', headers })
  ).json()
  expect(list.items[0].model).toBeTruthy()
  expect((await post('/api/agents/builder/routines/pin', {})).json()).toEqual({ pinned: [] })
})
