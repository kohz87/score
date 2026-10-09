import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { AgentSummarySchema } from '@score/contract'
import { AgentDetailSchema } from '@score/contract'
import { defaultAgentStyle } from '../../../src/domain/agents.ts'
import { ProfilesReader } from '../../../src/hermes/live/profiles.ts'
import type { HermesRunner } from '../../../src/hermes/live/cli.ts'

let home: string
const fixture = fileURLToPath(new URL('../../fixtures/hermes/profiles/', import.meta.url))
const runner = vi.fn<HermesRunner>()
let reader: ProfilesReader
beforeEach(() => {
  home = fs.mkdtempSync(join(tmpdir(), 'score-profiles-'))
  fs.cpSync(join(fixture, 'default'), home, { recursive: true })
  for (const name of ['lead', 'builder', 'reviewer', 'designer'])
    fs.cpSync(join(fixture, name), join(home, 'profiles', name), { recursive: true })
  runner.mockReset().mockResolvedValue({
    exitCode: 0,
    stdout: JSON.stringify({
      default: 'fixture-model',
      provider: 'fixture-provider',
      fallback: 'fallback-model',
    }),
  })
  reader = new ProfilesReader(home, runner)
})
afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(home, { recursive: true, force: true })
})

test('fixture profiles yield validated details, metadata, nested skills and stable sorted defaults', async () => {
  const names = reader.names(['reviewer', 'lead', 'remote'])
  expect(names).toEqual(['builder', 'default', 'designer', 'lead', 'remote', 'reviewer'])
  for (const [index, name] of names.entries()) {
    const detail = AgentDetailSchema.parse(
      await reader.read(name, index, name === 'lead', { status: 'idle', activity: null }),
    )
    expect(AgentSummarySchema.safeParse(detail).success).toBe(true)
    expect(detail.style).toEqual(defaultAgentStyle(index))
    expect(detail).toMatchObject({
      id: name,
      served: name === 'lead',
      tools: [],
      routines: name === 'builder' ? expect.any(Array) : [],
      channels: [],
      permissions: [],
    })
    if (name !== 'remote') {
      expect(detail.personality.excerpt).toBe(`I am ${name}. I help the team work carefully.`)
      expect(detail.model).toMatchObject({
        id: 'fixture-model',
        via: 'fixture-provider',
        fallback: 'fallback-model',
      })
      expect(detail.rulesFile).toBe('AGENTS.md')
      expect(detail.skills).toHaveLength(1)
    }
  }
  expect(runner).toHaveBeenCalledWith(['-p', 'builder', 'config', 'get', '--json', 'model'], {
    hermesHome: home,
    timeoutMs: 5000,
    captureModel: true,
  })
})
test('routines come from the profile cron jobs file, redacted and skipping malformed entries', async () => {
  const detail = await reader.read('builder', 0, true, { status: 'idle', activity: null })
  expect(detail.routines).toEqual([
    {
      id: 'builder:a1b2c3d4e5f6',
      title: 'Morning digest',
      schedule: '0 9 * * *',
      description:
        "Summarise yesterday's merged pull requests for the team.\nKeep it short. Use token=[redacted] for the tracker.",
      lastRunAt: '2026-10-08T07:00:02.000Z',
      enabled: true,
    },
    {
      id: 'builder:0f1e2d3c4b5a',
      title: 'Dependency check',
      schedule: 'every 120m',
      description: 'Check for outdated dependencies.',
      lastRunAt: null,
      enabled: false,
    },
  ])
  fs.writeFileSync(join(home, 'profiles', 'builder', 'cron', 'jobs.json'), '{broken')
  expect(
    (await reader.read('builder', 0, true, { status: 'idle', activity: null })).routines,
  ).toEqual([])
})
const modelCalls = () =>
  runner.mock.calls.filter(([args]) => args.join(' ') === '-p builder config get --json model')
test('model reads cache by config mtime and refresh on change', async () => {
  await reader.read('builder', 0, true, { status: 'idle', activity: null })
  await reader.read('builder', 0, true, { status: 'working', activity: 'Running a turn' })
  expect(modelCalls()).toHaveLength(1)
  fs.utimesSync(join(home, 'profiles', 'builder', 'config.yaml'), 200, 200)
  runner.mockResolvedValue({ exitCode: 0, stdout: '"changed-model"' })
  expect(
    (await reader.read('builder', 0, true, { status: 'idle', activity: null })).model!.id,
  ).toBe('changed-model')
  expect(modelCalls()).toHaveLength(2)
})
test.each([
  { exitCode: 2, stdout: 'private output' },
  { exitCode: 0, stdout: '{broken' },
  { exitCode: 0, stdout: '{"api_key":"secret"}' },
  { exitCode: 0, stdout: 'x'.repeat(16385) },
])('invalid CLI output degrades safely: %j', async (result) => {
  runner.mockResolvedValue(result)
  expect((await reader.read('lead', 0, true, { status: 'idle', activity: null })).model).toBeNull()
})
test('redacts before truncating the first paragraph and metadata', async () => {
  fs.writeFileSync(
    join(home, 'SOUL.md'),
    `# Default\n\npassword=${'s'.repeat(400)}\n${'a'.repeat(300)}\n\nIgnore this paragraph.`,
  )
  fs.writeFileSync(
    join(home, 'profile.yaml'),
    'description: >-\n  Helps the team.\n  token=private-value\n',
  )
  const detail = await reader.read('default', 0, false, { status: 'offline', activity: null })
  expect(detail.personality.excerpt).toHaveLength(280)
  expect(detail.personality.excerpt).toContain('password=[redacted]')
  expect(detail.role).toBe('Helps the team. token=[redacted]')
  expect(JSON.stringify(detail)).not.toContain('private-value')
})
test('reads only allowlisted profile files, never secrets or symlink targets (fs spy)', async () => {
  fs.writeFileSync(join(home, 'profiles', 'builder', '.env'), 'planted-secret')
  fs.writeFileSync(join(home, 'profiles', 'builder', 'auth.json'), 'planted-secret')
  fs.mkdirSync(join(home, 'profiles', 'builder', 'credentials'))
  fs.writeFileSync(join(home, 'profiles', 'builder', 'credentials', 'key'), 'planted-secret')
  fs.symlinkSync(
    join(home, 'profiles', 'builder', 'auth.json'),
    join(home, 'profiles', 'designer', 'SOUL.md.tmp'),
  )
  fs.unlinkSync(join(home, 'profiles', 'designer', 'SOUL.md'))
  fs.renameSync(
    join(home, 'profiles', 'designer', 'SOUL.md.tmp'),
    join(home, 'profiles', 'designer', 'SOUL.md'),
  )
  fs.symlinkSync(join(home, 'profiles', 'builder'), join(home, 'profiles', 'linked'))
  fs.symlinkSync(
    join(home, 'profiles', 'builder', 'credentials'),
    join(home, 'skills', 'credential-link'),
  )
  const open = vi.spyOn(fs, 'openSync')
  const readFile = vi.spyOn(fs, 'readFileSync')
  for (const [index, name] of reader.names(['linked']).entries())
    await reader.read(name, index, true, { status: 'idle', activity: null })
  expect(open.mock.calls.length).toBeGreaterThan(0)
  for (const [path, flags] of open.mock.calls) {
    expect(['SOUL.md', 'profile.yaml', 'jobs.json', 'MEMORY.md', 'USER.md', 'SKILL.md']).toContain(
      basename(path.toString()),
    )
    expect(path.toString()).not.toMatch(/credentials|linked|designer\/SOUL/)
    expect(Number(flags) & fs.constants.O_NOFOLLOW).toBe(fs.constants.O_NOFOLLOW)
  }
  expect(readFile).not.toHaveBeenCalled()
})
test('missing files and unavailable directories remain readable; invalid names are rejected', async () => {
  const missing = new ProfilesReader(join(home, 'missing'), runner)
  expect(missing.names([])).toEqual(['default'])
  const detail = await missing.read('default', 0, false, { status: 'offline', activity: null })
  expect(detail).toMatchObject({
    personality: { excerpt: '' },
    rulesFile: null,
    skills: [],
    model: null,
  })
  expect(runner).not.toHaveBeenCalled()
  await expect(
    reader.read('../outside', 0, false, { status: 'offline', activity: null }),
  ).rejects.toThrow()
})
test('palette uses all eight shapes and four token colors', () => {
  expect(
    new Set(Array.from({ length: 8 }, (_, index) => defaultAgentStyle(index).shape)).size,
  ).toBe(8)
  expect(defaultAgentStyle(8)).toEqual(defaultAgentStyle(0))
})

test('excerpt bounds preserve Unicode and skip headings without requiring a blank line', async () => {
  fs.writeFileSync(join(home, 'SOUL.md'), `# Default\n${'🙂'.repeat(300)}\n\nSecond paragraph.`)
  const detail = await reader.read('default', 0, false, { status: 'offline', activity: null })
  expect(detail.personality.excerpt).toBe('🙂'.repeat(140))
})
test('oversized files are never opened and symlinked config never invokes the CLI', async () => {
  fs.writeFileSync(join(home, 'SOUL.md'), 'x'.repeat(256 * 1024 + 1))
  fs.unlinkSync(join(home, 'config.yaml'))
  fs.symlinkSync(join(home, 'profiles', 'builder', 'config.yaml'), join(home, 'config.yaml'))
  const open = vi.spyOn(fs, 'openSync')
  const detail = await reader.read('default', 0, false, { status: 'offline', activity: null })
  expect(detail.personality.excerpt).toBe('')
  expect(open.mock.calls.map(([path]) => basename(path.toString()))).toEqual([
    'profile.yaml',
    'SKILL.md',
  ])
  expect(runner).not.toHaveBeenCalled()
})
