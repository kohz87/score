import { expect, test, vi } from 'vitest'
import { HttpError } from '../../../src/errors.ts'
import { LiveAgentTabs } from '../../../src/hermes/live/agent-tabs.ts'
import { captureReadShape, type HermesRunner } from '../../../src/hermes/live/cli.ts'

// Shaped like `hermes plugins list --json`.
const rows = (state: Record<string, string>) =>
  JSON.stringify([
    {
      name: 'score-bridge',
      status: 'enabled',
      version: '1',
      description: 'Bridge',
      source: 'user',
    },
    ...Object.entries(state).map(([name, status]) => ({
      name,
      status,
      version: '1.0.0',
      description: `${name} plugin. token=private-value`,
      source: 'bundled',
      removed: null,
    })),
    { name: '--bad', status: 'enabled' },
  ])

function setup(state: Record<string, string>, applies = true) {
  const runner = vi.fn<HermesRunner>(async (args) => {
    const [, , group, verb, name] = args
    if (group === 'plugins' && verb === 'list') return { exitCode: 0, stdout: rows(state) }
    if (group === 'plugins' && (verb === 'enable' || verb === 'disable')) {
      if (applies) state[name!] = verb === 'enable' ? 'enabled' : 'disabled'
      return { exitCode: 0 }
    }
    return { exitCode: 1 }
  })
  const tabs = new LiveAgentTabs(
    '/h',
    (profile) => (profile === 'builder' ? '/h/b' : null),
    vi.fn(),
    runner,
  )
  return { runner, tabs }
}

test('the list read is allowlisted for one profile and nothing else', () => {
  expect(captureReadShape(['-p', 'builder', 'plugins', 'list', '--json'])).toBe(true)
  expect(captureReadShape(['-p', 'builder', 'plugins', 'list'])).toBe(false)
  expect(captureReadShape(['-p', '../x', 'plugins', 'list', '--json'])).toBe(false)
  expect(captureReadShape(['-p', 'builder', 'plugins', 'enable', 'x'])).toBe(false)
})
test('lists enabled state, locks the bridge, redacts and skips odd names', async () => {
  const { tabs, runner } = setup({ memory: 'enabled', browser: 'not enabled', old: 'disabled' })
  const items = await tabs.listPlugins('builder')
  expect(items.map((item) => [item.id, item.enabled, item.locked])).toEqual([
    ['score-bridge', true, true],
    ['memory', true, false],
    ['browser', false, false],
    ['old', false, false],
  ])
  expect(JSON.stringify(items)).not.toContain('private-value')
  expect(runner.mock.calls[0]![0]).toEqual(['-p', 'builder', 'plugins', 'list', '--json'])
  expect(runner.mock.calls[0]![1]).toMatchObject({ captureRead: true, hermesHome: '/h' })
})
test('enable and disable use exact argv, verify by re-reading, and skip no-ops', async () => {
  const { tabs, runner } = setup({ memory: 'disabled' })
  expect(await tabs.setPluginEnabled('builder', 'memory', true)).toMatchObject({ enabled: true })
  expect(runner.mock.calls.map(([args]) => args).filter((args) => args[3] !== 'list')).toEqual([
    ['-p', 'builder', 'plugins', 'enable', 'memory'],
  ])
  runner.mockClear()
  await tabs.setPluginEnabled('builder', 'memory', true)
  expect(runner.mock.calls.some(([args]) => args[3] === 'enable')).toBe(false)
  await tabs.setPluginEnabled('builder', 'memory', false)
  expect(
    runner.mock.calls.some(([args]) => args.join(' ') === '-p builder plugins disable memory'),
  ).toBe(true)
})
test('a change Hermes does not keep, the bridge, unknown plugins and agents are refused', async () => {
  const { tabs } = setup({ memory: 'disabled' }, false)
  await expect(tabs.setPluginEnabled('builder', 'memory', true)).rejects.toMatchObject({
    status: 409,
  })
  await expect(tabs.setPluginEnabled('builder', 'score-bridge', false)).rejects.toBeInstanceOf(
    HttpError,
  )
  await expect(tabs.setPluginEnabled('builder', 'score_bridge', false)).rejects.toMatchObject({
    status: 409,
  })
  await expect(tabs.setPluginEnabled('builder', 'ghost', true)).rejects.toMatchObject({
    status: 404,
  })
  await expect(tabs.listPlugins('nobody')).rejects.toMatchObject({ status: 404 })
})
