import { beforeEach, expect, test, vi } from 'vitest'
import { LiveAgentTabs } from '../../../src/hermes/live/agent-tabs.ts'
import type { HermesRunner } from '../../../src/hermes/live/cli.ts'

// A stand-in `hermes` that keeps four config sections in memory and applies the sets and unsets it is sent.
let config: Record<string, unknown>
const runner = vi.fn<HermesRunner>()
function answer(args: string[]): { exitCode: number; stdout?: string } {
  const rest = args.slice(2)
  if (rest[0] === 'config' && rest[1] === 'get') {
    const value = rest[3]!
      .split('.')
      .reduce<unknown>(
        (node, part) => (node as Record<string, unknown> | undefined)?.[part],
        config,
      )
    return value === undefined ? { exitCode: 1 } : { exitCode: 0, stdout: JSON.stringify(value) }
  }
  if (rest[0] === 'config' && rest[1] === 'set') {
    const path = rest[2]!.split('.')
    const value = /^[[{]/.test(rest[3]!) ? JSON.parse(rest[3]!) : rest[3]
    let node = config
    for (const part of path.slice(0, -1)) node = (node[part] ??= {}) as Record<string, unknown>
    node[path.at(-1)!] = value
  }
  if (rest[0] === 'config' && rest[1] === 'unset') {
    const path = rest[2]!.split('.')
    let node = config
    for (const part of path.slice(0, -1)) node = node[part] as Record<string, unknown>
    delete node[path.at(-1)!]
  }
  return { exitCode: 0 }
}
const writes = () =>
  runner.mock.calls
    .map(([args]) => args)
    .filter((args) => args[2] === 'config' && args[3] !== 'get')
const reads = () => runner.mock.calls.filter(([args]) => args[3] === 'get').length
let tabs: LiveAgentTabs
beforeEach(() => {
  config = {
    tts: {
      provider: 'edge',
      edge: { voice: 'en-US-AriaNeural' },
      openai: { model: 'gpt-4o-mini-tts', voice: 'alloy' },
    },
    stt: { language: 'en', groq: { model: 'whisper-large-v3-turbo' } },
  }
  runner.mockReset()
  runner.mockImplementation(async (args) => answer(args))
  tabs = new LiveAgentTabs(
    '/tmp/none',
    () => '/tmp/none',
    () => undefined,
    runner,
  )
})

test('reads the fallback chain, aliases and the speech settings of the chosen providers', async () => {
  config.fallback_providers = [
    { provider: 'openrouter', model: 'a/b' },
    { provider: 'acme', model: 'c' },
  ]
  config.model_aliases = {
    fast: { model: 'm1', provider: 'openrouter' },
    custom: { model: 'm2', provider: 'custom', base_url: 'http://x', api_key: '***' },
  }
  const settings = await tabs.getModelSettings('builder')
  expect(settings.fallbacks).toEqual([
    { provider: 'openrouter', model: 'a/b' },
    { provider: 'acme', model: 'c' },
  ])
  expect(settings.fallbacksEditable).toBe(true)
  expect(settings.aliases).toEqual([
    { name: 'custom', model: 'm2', provider: 'custom', editable: false },
    { name: 'fast', model: 'm1', provider: 'openrouter', editable: true },
  ])
  expect(settings.speech).toEqual({
    stt: { provider: null, model: null },
    tts: { provider: 'edge', model: null, voice: 'en-US-AriaNeural' },
  })
  // Nothing outside the four sections and the one effort key is read.
  expect(reads()).toBe(6)
})

test('a chain with a custom endpoint is shown but never rewritten', async () => {
  config.fallback_providers = [{ provider: 'acme', model: 'c', base_url: 'http://x' }]
  const settings = await tabs.getModelSettings('builder')
  expect(settings.fallbacksEditable).toBe(false)
  expect(settings.fallbacks).toEqual([{ provider: 'acme', model: 'c' }])
  await expect(
    tabs.updateModelSettings('builder', { fallbacks: [{ provider: 'x', model: 'y' }] }),
  ).rejects.toMatchObject({ status: 409 })
  expect(writes()).toEqual([])
})

test('only changed keys are written, and the answer comes from what was written', async () => {
  const saved = await tabs.updateModelSettings('builder', {
    fallbacks: [{ provider: 'openrouter', model: 'a/b' }],
    speech: {
      tts: { provider: 'openai', model: 'gpt-4o-mini-tts', voice: 'nova' },
      stt: { provider: 'groq' },
    },
  })
  expect(writes()).toEqual([
    [
      '-p',
      'builder',
      'config',
      'set',
      'fallback_providers',
      '[{"provider":"openrouter","model":"a/b"}]',
    ],
    ['-p', 'builder', 'config', 'set', 'stt.provider', 'groq'],
    ['-p', 'builder', 'config', 'set', 'tts.provider', 'openai'],
    ['-p', 'builder', 'config', 'set', 'tts.openai.voice', 'nova'],
  ])
  expect(reads()).toBe(6)
  expect(saved.speech.tts).toEqual({ provider: 'openai', model: 'gpt-4o-mini-tts', voice: 'nova' })
  expect(saved.speech.stt).toEqual({ provider: 'groq', model: 'whisper-large-v3-turbo' })
  expect(saved.fallbacks).toEqual([{ provider: 'openrouter', model: 'a/b' }])
  runner.mockClear()
  // Saving the same values again writes nothing.
  await tabs.updateModelSettings('builder', {
    fallbacks: [{ provider: 'openrouter', model: 'a/b' }],
    speech: { tts: { voice: 'nova' } },
  })
  expect(writes()).toEqual([])
})

test('aliases: new and changed ones are set one key each, removed editable ones are unset', async () => {
  config.model_aliases = {
    fast: { model: 'm1', provider: 'openrouter' },
    old: { model: 'm0' },
    keep: { model: 'k', provider: 'p' },
  }
  const saved = await tabs.updateModelSettings('builder', {
    aliases: [
      { name: 'fast', model: 'm9', provider: 'openrouter' },
      { name: 'keep', model: 'k', provider: 'p' },
      { name: 'new', model: 'n' },
    ],
  })
  expect(writes()).toEqual([
    [
      '-p',
      'builder',
      'config',
      'set',
      'model_aliases.fast',
      '{"model":"m9","provider":"openrouter"}',
    ],
    ['-p', 'builder', 'config', 'set', 'model_aliases.new', '{"model":"n"}'],
    ['-p', 'builder', 'config', 'unset', 'model_aliases.old'],
  ])
  expect(saved.aliases.map((alias) => alias.name)).toEqual(['fast', 'keep', 'new'])
})

test('an alias with its own endpoint is kept; the speech provider without a field refuses it', async () => {
  config.model_aliases = { gate: { model: 'm', base_url: 'http://x' } }
  await expect(
    tabs.updateModelSettings('builder', { aliases: [{ name: 'gate', model: 'other' }] }),
  ).rejects.toMatchObject({ status: 409 })
  await expect(tabs.updateModelSettings('builder', { aliases: [] })).resolves.toMatchObject({
    aliases: [{ name: 'gate', editable: false }],
  })
  await expect(
    tabs.updateModelSettings('builder', { speech: { tts: { model: 'x' } } }),
  ).rejects.toMatchObject({ status: 409 })
  expect(writes()).toEqual([])
})

test.each([
  { fallbacks: [{ provider: '--x', model: 'm' }] },
  { aliases: [{ name: 'Bad Name', model: 'm' }] },
  { speech: { tts: { voice: 'a b' } } },
  { speech: { tts: { provider: 'nope' } } },
  { other: 1 },
])('hostile update %j is refused before anything runs', async (body) => {
  await expect(tabs.updateModelSettings('builder', body as never)).rejects.toThrow()
  expect(runner).not.toHaveBeenCalled()
})

test('an unreadable Hermes is a 502, a failed write a 409', async () => {
  runner.mockResolvedValue({ exitCode: -1 })
  await expect(tabs.getModelSettings('builder')).rejects.toMatchObject({ status: 502 })
  runner.mockReset()
  runner.mockImplementation(async (args) => (args[3] === 'set' ? { exitCode: 1 } : answer(args)))
  await expect(
    tabs.updateModelSettings('builder', { fallbacks: [{ provider: 'a', model: 'b' }] }),
  ).rejects.toMatchObject({ status: 409 })
})

test('a legacy fallback_model is part of the chain and is cleared with it (audit5-e)', async () => {
  config.fallback_model = { provider: 'openrouter', model: 'legacy/model' }
  config.fallback_providers = []
  const shown = await tabs.getModelSettings('builder')
  expect(shown.fallbacks).toEqual([{ provider: 'openrouter', model: 'legacy/model' }])
  expect(shown.fallbacksEditable).toBe(true)
  runner.mockClear()
  const saved = await tabs.updateModelSettings('builder', { fallbacks: [] })
  expect(writes()).toEqual([
    ['-p', 'builder', 'config', 'set', 'fallback_providers', '[]'],
    ['-p', 'builder', 'config', 'unset', 'fallback_model'],
  ])
  expect(config.fallback_model).toBeUndefined()
  expect(saved.fallbacks).toEqual([])
})

test('a legacy fallback_model with a custom endpoint is shown and protected (audit5-e)', async () => {
  config.fallback_model = { provider: 'acme', model: 'c', base_url: 'http://x' }
  const shown = await tabs.getModelSettings('builder')
  expect(shown.fallbacks).toEqual([{ provider: 'acme', model: 'c' }])
  expect(shown.fallbacksEditable).toBe(false)
  await expect(tabs.updateModelSettings('builder', { fallbacks: [] })).rejects.toMatchObject({
    status: 409,
  })
})

test('speech-to-text goes back to Automatic by unsetting the provider (audit5-e)', async () => {
  config.stt = { provider: 'groq', groq: { model: 'whisper-large-v3-turbo' } }
  const saved = await tabs.updateModelSettings('builder', { speech: { stt: { provider: null } } })
  expect(writes()).toEqual([['-p', 'builder', 'config', 'unset', 'stt.provider']])
  expect(saved.speech.stt).toEqual({ provider: null, model: null })
})

test('eleven fallbacks load and save (audit5-e)', async () => {
  const chain = Array.from({ length: 11 }, (_, n) => ({ provider: 'openrouter', model: `m/${n}` }))
  config.fallback_providers = chain
  expect((await tabs.getModelSettings('builder')).fallbacks).toHaveLength(11)
  const saved = await tabs.updateModelSettings('builder', { fallbacks: chain.slice().reverse() })
  expect(saved.fallbacks).toHaveLength(11)
})

test('a save that fails midway puts back what it already wrote (audit5-e)', async () => {
  config.model_aliases = { old: { model: 'm-old', provider: 'openrouter' } }
  config.stt = { provider: 'groq', groq: { model: 'whisper-large-v3-turbo' } }
  runner.mockImplementation(async (args) => {
    if (args.includes('unset') && args.includes('model_aliases.old')) return { exitCode: 1 }
    return answer(args)
  })
  await expect(
    tabs.updateModelSettings('builder', {
      aliases: [{ name: 'new', model: 'm-new', provider: 'openrouter' }],
      speech: { stt: { provider: 'openai' } },
    }),
  ).rejects.toBeDefined()
  // Rolled back: no new alias, the old one and the speech provider are as they were.
  expect(config.model_aliases).toEqual({ old: { model: 'm-old', provider: 'openrouter' } })
  expect((config.stt as Record<string, unknown>).provider).toBe('groq')
})

test('effort: reads agent.reasoning_effort only, shows Default when unset and a hand-set value as-is', async () => {
  expect((await tabs.getModelSettings('builder')).effort).toBeNull()
  config.agent = { reasoning_effort: 'high' }
  expect((await tabs.getModelSettings('builder')).effort).toBe('high')
  config.agent = { reasoning_effort: 'ultra' }
  expect((await tabs.getModelSettings('builder')).effort).toBe('ultra')
  const keys = runner.mock.calls.map(([args]) => args[5])
  expect(keys).not.toContain('agent')
  expect(keys).toContain('agent.reasoning_effort')
})

test('effort: set writes the level, Default unsets it, an unchanged level writes nothing', async () => {
  const saved = await tabs.updateModelSettings('builder', { effort: 'xhigh' })
  expect(writes()).toEqual([['-p', 'builder', 'config', 'set', 'agent.reasoning_effort', 'xhigh']])
  expect(saved.effort).toBe('xhigh')
  runner.mockClear()
  await tabs.updateModelSettings('builder', { effort: 'xhigh' })
  expect(writes()).toEqual([])
  const cleared = await tabs.updateModelSettings('builder', { effort: null })
  expect(writes()).toEqual([['-p', 'builder', 'config', 'unset', 'agent.reasoning_effort']])
  expect(cleared.effort).toBeNull()
})

test('effort: a level outside the list is refused before any write; a failed save puts the old value back', async () => {
  await expect(tabs.updateModelSettings('builder', { effort: 'ultra' as never })).rejects.toThrow()
  expect(writes()).toEqual([])
  config.agent = { reasoning_effort: 'low' }
  runner.mockImplementation(async (args) =>
    args[3] === 'set' && args[4] === 'stt.provider' ? { exitCode: 1 } : answer(args),
  )
  await expect(
    tabs.updateModelSettings('builder', { effort: 'high', speech: { stt: { provider: 'groq' } } }),
  ).rejects.toThrow()
  expect((config.agent as Record<string, unknown>).reasoning_effort).toBe('low')
})
