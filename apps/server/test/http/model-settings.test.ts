import fs from 'node:fs'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import {
  AgentDetailSchema,
  ModelSettingsSchema,
  ModelVisibilitySchema,
  ModelsResponseSchema,
} from '@score/contract'
import { buildApp } from '../../src/app.ts'
import { loadConfig } from '../../src/config.ts'
import { filterModels } from '../../src/hermes/model-options.ts'
import { FakePort } from '../../src/hermes/fake/fake-port.ts'
import { setup } from '../hermes/live/gateway/helpers.ts'

let env: ReturnType<typeof setup>
let app: ReturnType<typeof buildApp>
let port: FakePort
let headers: { 'x-score-client': string; cookie: string }
beforeEach(async () => {
  env = setup()
  port = new FakePort(1, { db: env.db }, false)
  await port.start(env.ingest)
  app = buildApp({
    config: loadConfig({ SCORE_MODE: 'fake' }),
    logger: false,
    port,
    db: env.db,
    ingest: env.ingest,
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
})
afterEach(async () => {
  await app.close()
  await port.stop()
  await env.ingest.close()
  env.db.close()
  fs.rmSync(env.home, { recursive: true, force: true })
})
const put = (url: string, payload: object) => app.inject({ method: 'PUT', url, headers, payload })
const models = async (query = '') =>
  ModelsResponseSchema.parse((await app.inject(`/api/models${query}`)).json())

test('model settings: save a fallback chain, an alias and speech models; the agent card says what it falls back to', async () => {
  const response = await put('/api/agents/builder/model-settings', {
    fallbacks: [
      { provider: 'nous', model: 'upstage/solar-mini4:free' },
      { provider: 'local', model: 'local-gpt-mini' },
    ],
    aliases: [{ name: 'fast', model: 'local-gpt-mini', provider: 'local' }],
    speech: { tts: { provider: 'openai', voice: 'nova' }, stt: { provider: 'groq' } },
  })
  expect(response.statusCode).toBe(200)
  const saved = ModelSettingsSchema.parse(response.json())
  expect(saved.fallbacks).toHaveLength(2)
  expect(saved.speech.tts.provider).toBe('openai')
  const read = ModelSettingsSchema.parse(
    (await app.inject('/api/agents/builder/model-settings')).json(),
  )
  expect(read).toEqual(saved)
  const detail = AgentDetailSchema.parse((await app.inject('/api/agents/builder')).json())
  expect(detail.model?.fallback).toBe('upstage/solar-mini4:free, then local-gpt-mini')
})

test('model settings need a paired human and a valid body', async () => {
  const anonymous = { 'x-score-client': 'web' }
  expect(
    (
      await app.inject({
        method: 'PUT',
        url: '/api/agents/builder/model-settings',
        headers: anonymous,
        payload: {},
      })
    ).statusCode,
  ).toBe(401)
  expect(
    (await put('/api/agents/builder/model-settings', { fallbacks: [{ model: 'x' }] })).statusCode,
  ).toBe(400)
  expect((await put('/api/agents/nobody/model-settings', {})).statusCode).toBe(404)
})

test('the chosen-models list narrows the picker until Show all, and reports what it hid', async () => {
  const everything = (await models()).items
  expect(everything.length).toBeGreaterThan(2)
  expect(
    ModelVisibilitySchema.parse((await app.inject('/api/settings/model-visibility')).json()).items,
  ).toEqual([])
  const chosen = [{ provider: 'local', model: 'local-gpt-mini' }]
  expect((await put('/api/settings/model-visibility', { items: chosen })).statusCode).toBe(200)
  const narrowed = await models()
  expect(narrowed.items.map((item) => item.model)).toEqual(['local-gpt-mini'])
  expect(narrowed.hiddenCount).toBe(everything.length - 1)
  const shown = await models('?all=1')
  expect(shown.items).toHaveLength(everything.length)
  expect(shown.hiddenCount).toBeUndefined()
  // Search stays inside the chosen list.
  expect((await models('?q=sol')).items).toEqual([])
  await put('/api/settings/model-visibility', { items: [] })
  expect((await models()).items).toHaveLength(everything.length)
})

test('an agent alias is found by the picker search and resolves in PUT model', async () => {
  await put('/api/agents/builder/model-settings', {
    aliases: [{ name: 'quick', model: 'local-gpt-mini', provider: 'local' }],
  })
  const found = await models('?q=quick&agentId=builder')
  expect(found.items[0]).toMatchObject({
    model: 'local-gpt-mini',
    provider: 'local',
    alias: 'quick',
  })
  expect((await models('?q=quick')).items).toEqual([])
  const changed = await put('/api/agents/builder/model', { model: 'Quick' })
  expect(changed.statusCode).toBe(200)
  expect(AgentDetailSchema.parse(changed.json()).model).toMatchObject({
    id: 'local-gpt-mini',
    via: 'local',
  })
})

test('an alias row without a confirmed provider never invents one', async () => {
  await put('/api/agents/builder/model-settings', {
    aliases: [{ name: 'hand', model: 'qwen3:8b-not-listed', provider: null }],
  })
  const found = await models('?q=hand&agentId=builder')
  expect(found.items[0]).toMatchObject({ model: 'qwen3:8b-not-listed', alias: 'hand' })
  expect(found.items[0]!.provider).not.toBe('custom')
  expect(found.items[0]!.provider).toBe('')
})

test('an alias with a custom endpoint is shown read-only in the picker and refused by PUT model (audit5-e)', async () => {
  const real = port.readModelSettings.bind(port)
  vi.spyOn(port, 'readModelSettings').mockImplementation(async (agentId) => ({
    ...(await real(agentId)),
    aliases: [{ name: 'private', model: 'gpt-x', provider: 'openrouter', editable: false }],
  }))
  const set = vi.spyOn(port, 'setAgentModel')
  const found = await models('?q=private&agentId=builder')
  expect(found.items[0]).toMatchObject({
    alias: 'private',
    available: false,
    reason: expect.stringContaining('custom endpoint'),
  })
  const refused = await put('/api/agents/builder/model', { model: 'private' })
  expect(refused.statusCode).toBe(409)
  expect(refused.json()).toMatchObject({ error: { message: expect.stringContaining('custom endpoint') } })
  expect(set).not.toHaveBeenCalled()
})

test('a providerless alias stays providerless in the picker even when the model has providers (audit5-e)', async () => {
  await put('/api/agents/builder/model-settings', {
    aliases: [{ name: 'hand', model: 'shared-model', provider: null }],
  })
  const real = port.listModels.bind(port)
  const row = (provider: string) => ({
    provider,
    providerLabel: provider,
    model: 'shared-model',
    available: true,
    reason: null,
    free: false,
    price: null,
  })
  vi.spyOn(port, 'listModels').mockImplementation(async (q, chosen) =>
    q === undefined ? [row('provider-a'), row('provider-b')] : real(q, chosen),
  )
  const found = await models('?q=hand&agentId=builder')
  expect(found.items[0]).toMatchObject({ alias: 'hand', provider: '' })
})

test('the picker still offers Show all when the chosen list is capped at 200 and more models match (audit5-e)', async () => {
  const rows = Array.from({ length: 240 }, (_, n) => ({
    provider: 'acme',
    providerLabel: 'Acme',
    model: `model-${String(n).padStart(3, '0')}`,
    available: true,
    reason: null,
    free: false,
    price: null,
  }))
  vi.spyOn(port, 'listModels').mockImplementation(async (q, only, limit) =>
    filterModels(rows, q, only, limit),
  )
  const chosen = rows.slice(0, 200).map(({ provider, model }) => ({ provider, model }))
  await put('/api/settings/model-visibility', { items: chosen })
  const shown = await models()
  expect(shown.items).toHaveLength(200)
  expect(shown.hiddenCount).toBe(40)
})
