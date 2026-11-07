import fs from 'node:fs'
import { basename, join } from 'node:path'
import { expect, test, vi } from 'vitest'
import { HttpError } from '../../../src/errors.ts'
import { readMemory } from '../../../src/hermes/live/memory.ts'
import { installAgentTabsHooks, type AgentTabsState } from './agent-tabs-helpers.ts'

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

test('details carry skills, tools, helpers and the latest memory from the same readers', async () => {
  disabled = ['implementation']
  const detail = await reader.read('builder', 0, true, { status: 'idle', activity: null })
  expect(detail.skills).toEqual([{ name: 'implementation', enabled: false }])
  expect(detail.tools).toHaveLength(6)
  expect(detail.helpersMax).toBe(4)
  expect(detail.memory.map((item) => item.text)).toEqual([
    'Prefers short status updates.',
    'Prefer small pull requests.',
    'Releases go out on Fridays. token=[redacted]',
    'The test suite runs with pnpm test.',
  ])
  expect(JSON.stringify(detail)).not.toContain('private-value')
  await reader.read('builder', 0, true, { status: 'idle', activity: null })
  expect(
    runner.mock.calls.filter(
      ([args]) => args.join(' ') === '-p builder tools list --platform api_server',
    ),
  ).toHaveLength(1)
})

test('memory reads page and filter; writes answer 501 and never touch Hermes', async () => {
  const all = tabs.listMemory('builder', {})
  expect(all.items).toHaveLength(4)
  expect(all.nextCursor).toBeNull()
  expect(tabs.listMemory('builder', { q: 'FRIDAYS' }).items).toHaveLength(1)
  const ids = all.items.map((item) => item.id)
  expect(new Set(ids).size).toBe(4)
  expect(ids).toEqual(readMemory(join(home, 'profiles', 'builder')).map((item) => item.id))
  expect(() => tabs.unsupportedMemoryWrite('builder')).toThrow(HttpError)
  expect(() => tabs.unsupportedMemoryWrite('builder')).toThrowError(/read-only/)
  expect(runner).not.toHaveBeenCalled()
})

test('memory files ignore symlinks and oversized files', () => {
  const dir = join(home, 'profiles', 'builder', 'memories')
  fs.writeFileSync(join(home, 'planted'), 'secret entry')
  fs.rmSync(join(dir, 'USER.md'))
  fs.symlinkSync(join(home, 'planted'), join(dir, 'USER.md'))
  fs.writeFileSync(join(dir, 'MEMORY.md'), 'x'.repeat(256 * 1024 + 1))
  expect(readMemory(join(home, 'profiles', 'builder'))).toEqual([])
})

test('reads and writes touch only allowlisted files, never credentials (fs spy)', async () => {
  const profile = join(home, 'profiles', 'builder')
  for (const name of ['.env', 'auth.json']) fs.writeFileSync(join(profile, name), 'planted-secret')
  fs.mkdirSync(join(profile, 'credentials'))
  fs.writeFileSync(join(profile, 'credentials', 'key'), 'planted-secret')
  const open = vi.spyOn(fs, 'openSync')
  const readFile = vi.spyOn(fs, 'readFileSync')
  await reader.read('builder', 0, true, { status: 'idle', activity: null })
  await tabs.listSkills('builder')
  tabs.listMemory('builder', {})
  await tabs.setSkillEnabled('builder', 'implementation', false)
  await tabs.setToolEnabled('builder', 'web', false)
  await tabs.setModel('builder', { model: 'm' })
  expect(open.mock.calls.length).toBeGreaterThan(0)
  for (const [path, flags] of open.mock.calls) {
    expect(['SOUL.md', 'profile.yaml', 'jobs.json', 'MEMORY.md', 'USER.md', 'SKILL.md']).toContain(
      basename(path.toString()),
    )
    expect(Number(flags) & fs.constants.O_NOFOLLOW).toBe(fs.constants.O_NOFOLLOW)
  }
  expect(readFile).not.toHaveBeenCalled()
  // The adapter never writes Hermes files itself: only the CLI stub changed state.
  expect(fs.readFileSync(join(profile, 'config.yaml'), 'utf8')).toContain('fixture-model')
})

test('a failed settings read is retried after a short delay even though config.yaml is unchanged', async () => {
  const now = vi.spyOn(Date, 'now')
  const at = Date.now()
  now.mockReturnValue(at)
  exit['tools list'] = -1
  const first = await reader.read('builder', 0, true, { status: 'idle', activity: null })
  expect(first.tools).toEqual([])
  delete exit['tools list']
  now.mockReturnValue(at + 1000)
  expect((await reader.read('builder', 0, true, { status: 'idle', activity: null })).tools).toEqual(
    [],
  )
  now.mockReturnValue(at + 60_000)
  const later = await reader.read('builder', 0, true, { status: 'idle', activity: null })
  expect(later.tools).toHaveLength(6)
  // Once everything answered, the result is cached against the file as before.
  runner.mockClear()
  now.mockReturnValue(at + 600_000)
  await reader.read('builder', 0, true, { status: 'idle', activity: null })
  expect(runner.mock.calls.filter(([args]) => args.includes('tools'))).toHaveLength(0)
})

test('memory pages say they are read-only against live Hermes', () => {
  expect(tabs.listMemory('builder', {}).writable).toBe(false)
})

test('channels for a profile come from the multiplexer host file, scoped to that profile', () => {
  fs.writeFileSync(
    join(home, 'gateway_state.json'),
    JSON.stringify({
      platforms: {
        telegram: { state: 'connected' },
        'builder:discord': { state: 'connected' },
        'other:slack': { state: 'connected' },
      },
    }),
  )
  const connected = (agent: string) =>
    tabs
      .listChannels(agent)
      .items.filter((row) => row.status === 'connected')
      .map((row) => row.platform)
  expect(connected('builder')).toEqual(['discord'])
  expect(connected('default')).toEqual(['telegram'])
})
