import { expect, test, vi } from 'vitest'
import { LiveModels } from '../../../src/hermes/live/models.ts'

type Providers = ConstructorParameters<typeof LiveModels>[0] extends () => Promise<infer P>
  ? NonNullable<P>
  : never
const providers: Providers = [
  {
    slug: 'openai-codex',
    name: 'OpenAI Codex',
    authenticated: true,
    models: ['gpt-6.1-sol', 'gpt-6-luna'],
    pricing: { 'gpt-6.1-sol': { input: '$2.00', output: '$10.00', free: false } },
  },
  {
    slug: 'nous',
    name: 'Nous Portal',
    authenticated: true,
    models: ['openai/gpt-6.1-sol', 'upstage/solar-mini4:free'],
    unavailable_models: ['openai/gpt-6.1-sol'],
  },
  { slug: 'anthropic', name: 'Anthropic', authenticated: false, models: ['claude-x'] },
  { slug: 'empty', name: 'Empty', authenticated: true, models: [] },
]

test('lists connected providers only, available first, with price, plan reason and free', async () => {
  const models = new LiveModels(async () => providers)
  const items = await models.list()
  expect(items.map((i) => `${i.provider}:${i.model}`)).toEqual([
    'openai-codex:gpt-6-luna',
    'openai-codex:gpt-6.1-sol',
    'nous:upstage/solar-mini4:free',
    'nous:openai/gpt-6.1-sol',
  ])
  expect(items[0]!.providerLabel).toBe('ChatGPT (Codex)')
  expect(items[1]!.price).toEqual({ input: '$2.00', output: '$10.00' })
  expect(items[2]!.free).toBe(true)
  expect(items[3]).toMatchObject({ available: false, reason: 'Not on your plan' })
})

test('q needs every term in the model or the provider label', async () => {
  const models = new LiveModels(async () => providers)
  expect((await models.list('GPT')).length).toBe(3)
  expect((await models.list('gpt nous')).map((i) => i.model)).toEqual(['openai/gpt-6.1-sol'])
  expect(await models.list('zzz')).toEqual([])
})

test('caps at 200, caches for 30 s and answers [] when the gateway is down', async () => {
  let now = 0
  const many = [
    {
      slug: 'big',
      name: 'Big',
      authenticated: true,
      models: Array.from({ length: 300 }, (_, i) => `m${i}`),
    },
  ]
  const load = vi.fn(async () => many)
  const models = new LiveModels(load, () => now)
  expect((await models.list()).length).toBe(200)
  now = 29_000
  await models.list()
  expect(load).toHaveBeenCalledTimes(1)
  now = 31_000
  await models.list()
  expect(load).toHaveBeenCalledTimes(2)
  const down = new LiveModels(async () => {
    throw new Error('down')
  })
  expect(await down.list('gpt')).toEqual([])
})
