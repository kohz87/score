import { expect, test, vi } from 'vitest'
import { LiveAgentTabs } from '../../../src/hermes/live/agent-tabs.ts'
import type { HermesRunner } from '../../../src/hermes/live/cli.ts'
import { cachingRunner } from '../../../src/hermes/live/config-cache.ts'
import { hermes, installAgentTabsHooks, type AgentTabsState, writes } from './agent-tabs-helpers.ts'

let home: AgentTabsState['home']
let disabled: AgentTabsState['disabled']
let exit: AgentTabsState['exit']
let runner: AgentTabsState['runner']
let reader: AgentTabsState['reader']
let tabs: AgentTabsState['tabs']
const testState: AgentTabsState = {
  get home() {
    return home
  },
  set home(value) {
    home = value
  },
  get disabled() {
    return disabled
  },
  set disabled(value) {
    disabled = value
  },
  get exit() {
    return exit
  },
  set exit(value) {
    exit = value
  },
  get runner() {
    return runner
  },
  set runner(value) {
    runner = value
  },
  get reader() {
    return reader
  },
  set reader(value) {
    reader = value
  },
  get tabs() {
    return tabs
  },
  set tabs(value) {
    tabs = value
  },
}
installAgentTabsHooks(testState)

test('setModel writes model.default then model.provider with exact argv', async () => {
  await tabs.setModel('builder', { model: 'next-model', provider: 'acme' })
  expect(writes()).toEqual([
    ['-p', 'builder', 'config', 'set', 'model.default', 'next-model'],
    ['-p', 'builder', 'config', 'set', 'model.provider', 'acme'],
  ])
  expect(runner.mock.calls[0]![1]).toMatchObject({ hermesHome: home })
  runner.mockClear()
  await tabs.setModel('builder', { model: 'plain' })
  expect(writes()).toEqual([['-p', 'builder', 'config', 'set', 'model.default', 'plain']])
})

test('setModel costs two writes and, behind the cache, no repeated reads', async () => {
  const cached = cachingRunner(runner, home)
  const cachedTabs = new LiveAgentTabs(
    home,
    (profile) => reader.profileHome(profile),
    (profile) => reader.invalidate(profile),
    cached,
  )
  const reads = () => runner.mock.calls.filter(([args]) => args.includes('get')).length
  await cachedTabs.setModel('builder', { model: 'one', provider: 'acme' })
  // The shared providers list and the prior pair: two reads, then the two writes.
  expect(reads()).toBe(2)
  expect(writes()).toHaveLength(2)
  await cachedTabs.setModel('builder', { model: 'two', provider: 'acme' })
  // Only builder's pair is re-read after the write dropped it; the default profile's providers stay cached.
  expect(reads()).toBe(3)
})

test.each([
  { model: '--force' },
  { model: 'a b' },
  { model: 'x\0y' },
  { model: '' },
  { model: 'm', extra: 1 },
])('setModel rejects hostile input %j before running anything', async (body) => {
  await expect(tabs.setModel('builder', body as never)).rejects.toThrow()
  expect(runner).not.toHaveBeenCalled()
})

test('unknown agents are 404 and Hermes failures map to 409 / 502', async () => {
  await expect(tabs.setModel('nobody', { model: 'm' })).rejects.toMatchObject({ status: 404 })
  await expect(tabs.setModel('../x', { model: 'm' })).rejects.toMatchObject({ status: 404 })
  exit['config set'] = 1
  await expect(tabs.setModel('builder', { model: 'm' })).rejects.toMatchObject({
    status: 409,
    code: 'conflict',
  })
  exit['config set'] = -1
  await expect(tabs.setModel('builder', { model: 'm' })).rejects.toMatchObject({ status: 502 })
})

test('concurrent model changes cannot interleave their two config writes', async () => {
  const order: string[] = []
  runner.mockImplementation(async (args) => {
    if (args.includes('set')) {
      order.push(args.slice(-2).join('='))
      await new Promise((resolve) => setTimeout(resolve, 5))
    }
    return hermes(args)
  })
  await Promise.all([
    tabs.setModel('builder', { model: 'model-a', provider: 'prov-a' }),
    tabs.setModel('builder', { model: 'model-b', provider: 'prov-b' }),
  ])
  expect(order).toEqual([
    'model.default=model-a',
    'model.provider=prov-a',
    'model.default=model-b',
    'model.provider=prov-b',
  ])
})

test('a failed provider write restores the previous model and provider', async () => {
  runner.mockClear()
  const base = runner.getMockImplementation()!
  runner.mockImplementation(async (args, options) =>
    args.includes('model.provider') && args.at(-1) === 'acme'
      ? { exitCode: 1 }
      : base(args, options),
  )
  await expect(
    tabs.setModel('builder', { model: 'next-model', provider: 'acme' }),
  ).rejects.toMatchObject({ status: 409 })
  expect(writes()).toEqual([
    ['-p', 'builder', 'config', 'set', 'model.default', 'next-model'],
    ['-p', 'builder', 'config', 'set', 'model.provider', 'acme'],
    ['-p', 'builder', 'config', 'set', 'model.default', 'fixture-model'],
    ['-p', 'builder', 'config', 'set', 'model.provider', 'p'],
  ])
})

test('a local provider only the default profile defines is copied into the agent first (2.0.3)', async () => {
  const base = runner.getMockImplementation()!
  const providers: Record<string, unknown> = {
    default: { lab: { base_url: 'http://127.0.0.1:1/v1' } },
    builder: {},
  }
  runner.mockImplementation(async (args, options) =>
    args.join(' ').endsWith('config get --json providers')
      ? { exitCode: 0, stdout: JSON.stringify(providers[args[1]!]) }
      : base(args, options),
  )
  await tabs.setModel('builder', { model: 'm', provider: 'lab' })
  // The copy (address and a name, since the entry has none), then the model and provider.
  expect(writes().slice(0, 2)).toEqual([
    ['-p', 'builder', 'config', 'set', 'providers.lab.base_url', 'http://127.0.0.1:1/v1'],
    ['-p', 'builder', 'config', 'set', 'providers.lab.name', 'lab'],
  ])
  expect(writes()).toHaveLength(4)
  runner.mockClear()
  providers.builder = { lab: { base_url: 'http://127.0.0.1:1/v1' } }
  await tabs.setModel('builder', { model: 'm2', provider: 'lab' })
  // Already there: no copy, and only the changed model is written.
  expect(writes().some((args) => args.join(' ').includes('providers.lab'))).toBe(false)
  // built-in providers are not local entries and stay selectable
  runner.mockClear()
  await tabs.setModel('builder', { model: 'm', provider: 'openai' })
  expect(writes()).toHaveLength(2)
})

function modelRunner(initial: unknown, failing?: string) {
  const state = { model: initial as unknown }
  const calls: string[][] = []
  const run = vi.fn<HermesRunner>(async (args) => {
    const [, , ...rest] = args
    calls.push(rest)
    if (rest.join(' ') === 'config get --json model')
      return state.model === undefined
        ? { exitCode: 1 }
        : state.model === 'UNREADABLE'
          ? { exitCode: -1 }
          : { exitCode: 0, stdout: JSON.stringify(state.model) }
    if (rest[0] === 'config' && rest[1] === 'set') {
      if (rest[2] === failing) return { exitCode: 1 }
      const [, , key, value] = rest as [string, string, string, string]
      if (key === 'model') state.model = value
      else {
        const dict = typeof state.model === 'object' && state.model ? { ...state.model } : {}
        if (typeof state.model === 'string') Object.assign(dict, { default: state.model })
        Object.assign(dict, { [key.replace('model.', '')]: value })
        state.model = dict
      }
    }
    return { exitCode: 0 }
  })
  const own = new LiveAgentTabs(
    home,
    (profile) => reader.profileHome(profile),
    (profile) => reader.invalidate(profile),
    run,
  )
  return { own, state, calls }
}

test('a failed provider write puts a scalar model back exactly as it was', async () => {
  const { own, state } = modelRunner('plain-model', 'model.provider')
  await expect(own.setModel('builder', { model: 'next', provider: 'acme' })).rejects.toBeTruthy()
  expect(state.model).toBe('plain-model')
})

test('a failed provider write restores an object model, clearing a provider that was not set', async () => {
  const { own, state } = modelRunner({ default: 'old' }, 'model.provider')
  await expect(own.setModel('builder', { model: 'next', provider: 'acme' })).rejects.toBeTruthy()
  expect(state.model).toEqual({ default: 'old' })
})

test('an unreadable current model stops the change before any write', async () => {
  const { own, calls } = modelRunner('UNREADABLE')
  await expect(own.setModel('builder', { model: 'next' })).rejects.toMatchObject({ status: 502 })
  expect(calls.filter((c) => c[1] === 'set')).toEqual([])
})
