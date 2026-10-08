import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { HttpError } from '../../../src/errors.ts'
import { parseToolList } from '../../../src/hermes/live/agent-config.ts'
import { LiveAgentTabs } from '../../../src/hermes/live/agent-tabs.ts'
import type { HermesRunner } from '../../../src/hermes/live/cli.ts'
import { ProfilesReader } from '../../../src/hermes/live/profiles.ts'
import { readMemory } from '../../../src/hermes/live/memory.ts'

const fixture = fileURLToPath(new URL('../../fixtures/hermes/', import.meta.url))
const toolsText = fs.readFileSync(join(fixture, 'tools-list.txt'), 'utf8')
let home: string
let disabled: string[] | undefined
let tools: Map<string, boolean>
let exit: Record<string, number>
// Stands in for the `hermes` binary: answers the allowlisted reads and applies the writes it is sent.
const runner = vi.fn<HermesRunner>()
function hermes(args: string[]): { exitCode: number; stdout?: string } {
  const [, , ...rest] = args[0] === '-p' ? args : ['-p', '', ...args]
  const verb = rest.join(' ')
  if (exit[rest[0] + ' ' + rest[1]] !== undefined)
    return { exitCode: exit[rest[0] + ' ' + rest[1]]! }
  if (verb === 'config get --json skills.disabled')
    return disabled ? { exitCode: 0, stdout: JSON.stringify(disabled) } : { exitCode: 1 }
  if (verb === 'config get --json delegation.max_concurrent_children')
    return { exitCode: 0, stdout: '4' }
  if (verb === 'config get --json model')
    return { exitCode: 0, stdout: JSON.stringify({ default: 'fixture-model', provider: 'p' }) }
  if (rest[0] === 'config' && rest[1] === 'set' && rest[2] === 'skills.disabled') {
    disabled = JSON.parse(rest[3]!)
    return { exitCode: 0 }
  }
  if (rest[0] === 'tools' && rest[1] === 'list')
    return {
      exitCode: 0,
      stdout: toolsText
        .split('\n')
        .map((line) => {
          const id = /^\s+[✓✗] \w+\s+(\S+)/u.exec(line)?.[1]
          return id && tools.has(id)
            ? line.replace(/[✓✗] (enabled|disabled)/u, tools.get(id) ? '✓ enabled' : '✗ disabled')
            : line
        })
        .join('\n'),
    }
  if (rest[0] === 'tools' && (rest[1] === 'enable' || rest[1] === 'disable')) {
    tools.set(rest[3]!, rest[1] === 'enable')
    return { exitCode: 0 }
  }
  if (rest[0] === 'skills' && rest[1] === 'search')
    return {
      exitCode: 0,
      stdout: JSON.stringify([
        {
          name: 'changelog-writer',
          identifier: 'example/skills/changelog-writer',
          source: 'official',
          trust_level: 'builtin',
          description: 'Drafts a changelog. token=private-value',
          extra: 1,
        },
      ]),
    }
  return { exitCode: 0 }
}
let reader: ProfilesReader
let tabs: LiveAgentTabs
beforeEach(() => {
  home = fs.mkdtempSync(join(tmpdir(), 'score-tabs-'))
  fs.cpSync(join(fixture, 'profiles', 'default'), home, { recursive: true })
  fs.cpSync(join(fixture, 'profiles', 'builder'), join(home, 'profiles', 'builder'), {
    recursive: true,
  })
  disabled = undefined
  tools = new Map()
  exit = {}
  runner.mockReset().mockImplementation(async (args) => hermes(args))
  reader = new ProfilesReader(home, runner)
  tabs = new LiveAgentTabs(
    home,
    (profile) => reader.profileHome(profile),
    (profile) => reader.invalidate(profile),
    runner,
  )
})
afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(home, { recursive: true, force: true })
})
const writes = () =>
  runner.mock.calls
    .map(([args]) => args)
    .filter((args) => !['get', 'list', 'search'].some((verb) => args.includes(verb)))

test('tools list parses toolsets and MCP servers from plain output', () => {
  expect(parseToolList(toolsText)).toEqual([
    { id: 'web', label: 'Web Search & Scraping', kind: 'builtin', enabled: true },
    { id: 'terminal', label: 'Terminal & Processes', kind: 'builtin', enabled: true },
    { id: 'video', label: 'Video Analysis', kind: 'builtin', enabled: false },
    { id: 'a2a', label: 'A2A', kind: 'builtin', enabled: false },
    { id: 'tracker', label: 'tracker', kind: 'mcp', enabled: true },
    { id: 'docs', label: 'docs', kind: 'mcp', enabled: false },
  ])
  expect(parseToolList('garbage\nno sections')).toEqual([])
})

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
    runner.mock.calls.filter(([args]) => args.join(' ') === '-p builder tools list'),
  ).toHaveLength(1)
})

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

test('skill toggles rewrite skills.disabled through config set and keep other entries', async () => {
  disabled = ['other']
  expect(await tabs.listSkills('builder')).toEqual([{ name: 'implementation', enabled: true }])
  await tabs.setSkillEnabled('builder', 'implementation', false)
  expect(writes()).toEqual([
    ['-p', 'builder', 'config', 'set', 'skills.disabled', '["implementation","other"]'],
  ])
  runner.mockClear()
  await tabs.setSkillEnabled('builder', 'implementation', false)
  expect(writes()).toEqual([])
  await tabs.setSkillEnabled('builder', 'implementation', true)
  expect(writes()).toEqual([['-p', 'builder', 'config', 'set', 'skills.disabled', '["other"]']])
  await expect(tabs.setSkillEnabled('builder', 'missing', true)).rejects.toMatchObject({
    status: 404,
  })
})
test('install runs skills install with --yes and a literal identifier', async () => {
  await tabs.installSkill('builder', { name: 'example/skills/changelog-writer' })
  expect(writes()).toEqual([
    ['-p', 'builder', 'skills', 'install', '--yes', '--', 'example/skills/changelog-writer'],
  ])
  expect(runner.mock.calls[0]![1].timeoutMs).toBe(120000)
  for (const name of ['-x', 'a b', 'a;b', '']) {
    await expect(tabs.installSkill('builder', { name })).rejects.toThrow()
  }
  exit['skills install'] = 1
  await expect(tabs.installSkill('builder', { name: 'a/b' })).rejects.toMatchObject({ status: 409 })
})
test('hub search validates, redacts and bounds the result', async () => {
  expect(await tabs.searchHub('   ')).toEqual([])
  expect(runner).not.toHaveBeenCalled()
  expect(await tabs.searchHub('changelog')).toEqual([
    {
      name: 'changelog-writer',
      identifier: 'example/skills/changelog-writer',
      source: 'official',
      trust: 'builtin',
      description: 'Drafts a changelog. token=[redacted]',
    },
  ])
  expect(runner).toHaveBeenCalledWith(
    ['skills', 'search', '--json', '--limit', '20', '--', 'changelog'],
    { timeoutMs: 30000, hermesHome: home, captureRead: true },
  )
  runner.mockResolvedValue({ exitCode: 0, stdout: 'not json' })
  await expect(tabs.searchHub('x')).rejects.toMatchObject({ status: 502 })
  runner.mockResolvedValue({ exitCode: 1 })
  await expect(tabs.searchHub('x')).rejects.toMatchObject({ status: 502 })
})

test('tool toggles use tools enable/disable on the toolset id and verify the result', async () => {
  const on = await tabs.setToolEnabled('builder', 'video', true)
  expect(on).toMatchObject({ id: 'video', enabled: true })
  expect(writes()).toEqual([['-p', 'builder', 'tools', 'enable', '--', 'video']])
  runner.mockClear()
  await tabs.setToolEnabled('builder', 'video', true)
  expect(writes()).toEqual([])
  await tabs.setToolEnabled('builder', 'web', false)
  expect(writes()).toEqual([['-p', 'builder', 'tools', 'disable', '--', 'web']])
  await expect(tabs.setToolEnabled('builder', 'nope', true)).rejects.toMatchObject({ status: 404 })
  await expect(tabs.setToolEnabled('builder', 'tracker', false)).rejects.toMatchObject({
    status: 501,
  })
  await expect(tabs.setToolEnabled('builder', '--all', true)).rejects.toThrow()
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
    expect(['SOUL.md', 'profile.yaml', 'jobs.json', 'MEMORY.md', 'USER.md']).toContain(
      basename(path.toString()),
    )
    expect(Number(flags) & fs.constants.O_NOFOLLOW).toBe(fs.constants.O_NOFOLLOW)
  }
  expect(readFile).not.toHaveBeenCalled()
  // The adapter never writes Hermes files itself: only the CLI stub changed state.
  expect(fs.readFileSync(join(profile, 'config.yaml'), 'utf8')).toContain('fixture-model')
})
