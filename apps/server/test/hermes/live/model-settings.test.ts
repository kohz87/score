import { beforeEach, expect, test, vi } from 'vitest'
import { LiveAgentTabs } from '../../../src/hermes/live/agent-tabs.ts'
import type { HermesRunner } from '../../../src/hermes/live/cli.ts'

// A stand-in `hermes` that keeps four config sections in memory and applies the sets and unsets it is sent.
let config: Record<string, unknown>
const runner = vi.fn<HermesRunner>()
function answer(args: string[]): { exitCode: number; stdout?: string } {
  const rest = args.slice(2)
  if (rest[0] === 'config' && rest[1] === 'get') {
    const value = config[rest[3]!]
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
  runner.mock.calls.map(([args]) => args).filter((args) => args[2] === 'config' && args[3] !== 'get')
const reads = () => runner.mock.calls.filter(([args]) => args[3] === 'get').length
let tabs: LiveAgentTabs
beforeEach(() => {
  config = {
    tts: { provider: 'edge', edge: { voice: 'en-US-AriaNeural' }, openai: { model: 'gpt-4o-mini-tts', voice: 'alloy' } },
    stt: { language: 'en', groq: { model: 'whisper-large-v3-turbo' } },
  }
  runner.mockReset()
  runner.mockImplementation(async (args) => answer(args))
  tabs = new LiveAgentTabs('/tmp/none', () => '/tmp/none', () => undefined, runner)
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
  // Nothing outside the four sections is read.
  expect(reads()).toBe(4)
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
    speech: { tts: { provider: 'openai', model: 'gpt-4o-mini-tts', voice: 'nova' }, stt: { provider: 'groq' } },
  })
  expect(writes()).toEqual([
    ['-p', 'builder', 'config', 'set', 'fallback_providers', '[{"provider":"openrouter","model":"a/b"}]'],
    ['-p', 'builder', 'config', 'set', 'stt.provider', 'groq'],
    ['-p', 'builder', 'config', 'set', 'tts.provider', 'openai'],
    ['-p', 'builder', 'config', 'set', 'tts.openai.voice', 'nova'],
  ])
  expect(reads()).toBe(4)
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
    ['-p', 'builder', 'config', 'set', 'model_aliases.fast', '{"model":"m9","provider":"openrouter"}'],
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
  await expect(
    tabs.updateModelSettings('builder', { aliases: [] }),
  ).resolves.toMatchObject({ aliases: [{ name: 'gate', editable: false }] })
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
