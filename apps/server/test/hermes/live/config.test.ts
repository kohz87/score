import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { ConfigPreviewResponseSchema } from '@score/contract'
import { createLiveConfigService } from '../../../src/hermes/live/config.ts'
import { runHermes, type HermesRunner } from '../../../src/hermes/live/cli.ts'

const SECRET = 'sk-or-v1-planted-secret-value-1234567890'
let home: string
let store: Record<string, Record<string, unknown>>
const runner = vi.fn<HermesRunner>()
let rewriteOnSet: ((key: string, value: string) => void) | undefined

function setNested(root: Record<string, unknown>, path: string[], value: unknown) {
  let node = root
  for (const name of path.slice(0, -1)) node = (node[name] ??= {}) as Record<string, unknown>
  node[path.at(-1)!] = value
}
function coerce(value: string): unknown {
  if (value === 'true' || value === 'false') return value === 'true'
  if (/^-?\d+$/.test(value)) return Number(value)
  if (/^[[{]/.test(value)) return JSON.parse(value) as unknown
  return value
}
beforeEach(() => {
  home = fs.mkdtempSync(join(tmpdir(), 'score-config-'))
  fs.writeFileSync(join(home, '.env'), `OPENROUTER_API_KEY=${SECRET}\n`)
  fs.writeFileSync(join(home, 'auth.json'), JSON.stringify({ token: SECRET }))
  store = {
    agent: { max_turns: 60, verbose: false },
    display: { compact: false, language: 'en' },
    gateway: { port: 8642 },
    // Hermes masks these; the planted value proves Score would not pass one through even if it did not.
    auxiliary: { vision: { api_key: SECRET, provider: 'auto' } },
    terminal: { env_passthrough: [SECRET], backend: 'local' },
    providers: { lab: { api_key: SECRET } },
  }
  rewriteOnSet = undefined
  runner.mockReset().mockImplementation(async (args) => {
    if (args[0] === 'config' && args[1] === 'get') {
      const section = store[args[3]!]
      return section === undefined
        ? { exitCode: 1 }
        : { exitCode: 0, stdout: JSON.stringify(section) }
    }
    if (args[0] === 'config' && args[1] === 'set') {
      rewriteOnSet?.(args[2]!, args[3]!)
      setNested(store, args[2]!.split('.'), coerce(args[3]!))
      return { exitCode: 0 }
    }
    return { exitCode: 1 }
  })
})
afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(home, { recursive: true, force: true })
})
const service = () => createLiveConfigService(home, runner)
const setCalls = () => runner.mock.calls.filter(([args]) => args[1] === 'set').map(([args]) => args)

test('search finds keys by name and by comment, reads values per section, at most 50', async () => {
  const byName = await service().search('max_turns')
  expect(byName[0]).toMatchObject({ key: 'agent.max_turns', value: 60, file: 'config.yaml' })
  expect(byName[0]!.description).toContain('Turn cap')
  const byComment = await service().search('IANA timezone')
  expect(byComment.map((item) => item.key)).toContain('timezone')
  const everything = await service().search('')
  expect(everything).toHaveLength(50)
  expect((await service().search('zzz-no-such-setting')).length).toBe(0)
  // One read per section, never one per key.
  runner.mockClear()
  await service().search('agent')
  const reads = runner.mock.calls.map(([args]) => args.join(' '))
  expect(reads.length).toBeGreaterThan(0)
  expect(new Set(reads).size).toBe(reads.length)
  expect(reads.every((line) => /^config get --json [a-z_]+$/.test(line))).toBe(true)
  expect(runner.mock.calls.every(([, options]) => options.captureRead === true)).toBe(true)
})
test('excluded keys are never searchable, by name or by comment, and never read', async () => {
  for (const query of [
    'api_key',
    'auxiliary.vision.api_key',
    'providers',
    'token',
    'secret',
    'env_passthrough',
    'headers',
    'password',
    'credential',
  ]) {
    const items = await service().search(query)
    expect(JSON.stringify(items)).not.toContain(SECRET)
    for (const item of items)
      expect(item.key).not.toMatch(
        /api_key|token|secret|passw|credential|header|env_pass|^providers|\.providers/i,
      )
  }
  const all = await service().search('')
  expect(all.map((item) => item.key)).not.toContain('auxiliary.vision.api_key')
  expect(runner.mock.calls.map(([args]) => args[3])).not.toContain('providers')
  expect(JSON.stringify(await service().search('vision'))).not.toContain(SECRET)
})
test('values are scrubbed of secret-named members', async () => {
  store.agent!.max_turns = { api_key: SECRET, nested: SECRET }
  const [item] = await service().search('max_turns')
  expect(JSON.stringify(item)).not.toContain(SECRET)
  expect(JSON.stringify(item)).not.toContain('api_key')
})
test('preview is a unified diff of the affected keys with a stable sha256 hash', async () => {
  const changes = [
    { key: 'display.compact', value: true },
    { key: 'agent.max_turns', value: 30 },
  ]
  const preview = ConfigPreviewResponseSchema.parse(await service().preview(changes))
  expect(preview.file).toBe('config.yaml')
  expect(preview.diff).toContain('-agent.max_turns: 60')
  expect(preview.diff).toContain('+agent.max_turns: 30')
  expect(preview.diff).toContain('-display.compact: false')
  expect(preview.diff).toContain('+display.compact: true')
  expect(setCalls()).toEqual([])
  expect((await service().preview([...changes].reverse())).hash).toBe(preview.hash)
  expect((await service().preview([{ key: 'agent.max_turns', value: 31 }])).hash).not.toBe(
    preview.hash,
  )
})
test('apply with the matching hash runs one exact `config set` per change and verifies', async () => {
  const changes = [
    { key: 'display.compact', value: true },
    { key: 'agent.max_turns', value: 30 },
    { key: 'display.language', value: 'de' },
  ]
  const { hash } = await service().preview(changes)
  await expect(service().apply({ changes, expectedDiffHash: hash })).resolves.toEqual({
    ok: true,
    restartRequired: false,
  })
  expect(setCalls()).toEqual([
    ['config', 'set', 'agent.max_turns', '30'],
    ['config', 'set', 'display.compact', 'true'],
    ['config', 'set', 'display.language', 'de'],
  ])
  expect(
    runner.mock.calls
      .filter(([args]) => args[1] === 'set')
      .every(([, options]) => options.captureRead !== true && options.hermesHome === home),
  ).toBe(true)
  expect(store.agent!.max_turns).toBe(30)
})
test('gateway keys report restartRequired; list values travel as JSON text', async () => {
  const changes = [{ key: 'gateway.allow_all_users', value: true }]
  const { hash } = await service().preview(changes)
  await expect(service().apply({ changes, expectedDiffHash: hash })).resolves.toEqual({
    ok: true,
    restartRequired: true,
  })
  const list = [{ key: 'toolsets', value: ['a', 'b'] }]
  const second = await service().preview(list)
  await service().apply({ changes: list, expectedDiffHash: second.hash })
  expect(setCalls().at(-1)).toEqual(['config', 'set', 'toolsets', '["a","b"]'])
})
test('a stale hash is a 409 and nothing is written; so is a hash for other changes', async () => {
  const changes = [{ key: 'agent.max_turns', value: 30 }]
  const { hash } = await service().preview(changes)
  ;(store.agent as Record<string, unknown>).max_turns = 99 // changed meanwhile
  await expect(service().apply({ changes, expectedDiffHash: hash })).rejects.toMatchObject({
    status: 409,
  })
  await expect(
    service().apply({ changes: [{ key: 'agent.max_turns', value: 31 }], expectedDiffHash: hash }),
  ).rejects.toMatchObject({ status: 409 })
  await expect(
    service().apply({ changes, expectedDiffHash: '0'.repeat(64) }),
  ).rejects.toMatchObject({ status: 409 })
  expect(setCalls()).toEqual([])
})
test.each([
  'auxiliary.vision.api_key',
  'providers.lab.api_key',
  'providers.lab.base_url',
  'OPENROUTER_API_KEY',
  'openrouter_api_key',
  'terminal.env_passthrough',
  'mcp_servers.x.headers',
  'agent.not_a_known_setting',
  'agent.max_turns.deeper..x',
  '_config_version',
  // Owned by Rules and approvals (2.18): never editable here.
  'approvals.mode',
  'approvals.deny',
  'command_allowlist',
  // Owned by the Skills tab.
  'skills.disabled',
])('writing %j is a 400 for preview and apply, and no argv is built', async (key) => {
  const changes = [{ key, value: 'x' }]
  await expect(service().preview(changes)).rejects.toMatchObject({ status: 400 })
  await expect(
    service().apply({ changes, expectedDiffHash: 'a'.repeat(64) }),
  ).rejects.toMatchObject({ status: 400 })
  // One excluded change poisons a batch that also holds a valid one.
  const batch = [{ key: 'display.compact', value: true }, ...changes]
  await expect(
    service().apply({ changes: batch, expectedDiffHash: 'a'.repeat(64) }),
  ).rejects.toMatchObject({ status: 400 })
  expect(setCalls()).toEqual([])
  expect(runner).not.toHaveBeenCalled()
})
test('values that the CLI would read as flags or that hold NUL are refused', async () => {
  for (const value of ['--force', ' -x', 'a\0b'])
    await expect(service().preview([{ key: 'display.language', value }])).rejects.toMatchObject({
      status: 400,
    })
  await expect(service().preview([{ key: 'agent.max_turns', value: -1 }])).resolves.toBeDefined()
})
test('a refused or unverified write is a 502, not a success', async () => {
  const changes = [{ key: 'display.compact', value: true }]
  const { hash } = await service().preview(changes)
  runner.mockImplementation(async (args) =>
    args[1] === 'set' ? { exitCode: 1 } : { exitCode: 0, stdout: JSON.stringify(store.display) },
  )
  await expect(service().apply({ changes, expectedDiffHash: hash })).rejects.toMatchObject({
    status: 502,
  })
  runner.mockImplementation(async (args) =>
    args[1] === 'set' ? { exitCode: 0 } : { exitCode: 0, stdout: JSON.stringify(store.display) },
  )
  await expect(service().apply({ changes, expectedDiffHash: hash })).rejects.toMatchObject({
    status: 502,
  })
})
test('applies are serialized', async () => {
  const order: string[] = []
  rewriteOnSet = (key) => order.push(key)
  const first = [{ key: 'agent.max_turns', value: 30 }]
  const second = [{ key: 'display.compact', value: true }]
  const [a, b] = [await service().preview(first), await service().preview(second)]
  const svc = service()
  await Promise.all([
    svc.apply({ changes: first, expectedDiffHash: a.hash }),
    svc.apply({ changes: second, expectedDiffHash: b.hash }),
  ])
  expect(order).toEqual(['agent.max_turns', 'display.compact'])
})
test('config work opens no file in the Hermes home (fs spy)', async () => {
  const touched: string[] = []
  for (const name of [
    'openSync',
    'readFileSync',
    'statSync',
    'lstatSync',
    'readdirSync',
    'existsSync',
  ] as const) {
    const original = fs[name] as (...args: unknown[]) => unknown
    vi.spyOn(fs, name as 'openSync').mockImplementation(((...args: unknown[]) => {
      touched.push(String(args[0]))
      return original(...args)
    }) as never)
  }
  const promises = vi.spyOn(fs.promises, 'readFile')
  const svc = service()
  await svc.search('max_turns')
  const changes = [{ key: 'agent.max_turns', value: 5 }]
  await svc.apply({ changes, expectedDiffHash: (await svc.preview(changes)).hash })
  expect(touched.filter((path) => path.startsWith(home))).toEqual([])
  expect(touched.map((path) => basename(path))).not.toContain('.env')
  expect(promises).not.toHaveBeenCalled()
})
test('the real runner refuses a config read of an excluded name even if asked', async () => {
  const execute = vi.fn()
  await expect(
    runHermes(['config', 'get', '--json', 'providers'], {
      timeoutMs: 100,
      captureRead: true,
      execute,
    }),
  ).rejects.toThrow(/allowlisted reads/)
  expect(execute).not.toHaveBeenCalled()
})

test('the approval keys Rules and approvals owns are not searchable here', async () => {
  const keys = (await service().search('approval')).map((item) => item.key)
  expect(keys).not.toContain('approvals.mode')
  expect(keys).not.toContain('approvals.deny')
  expect(await service().search('command_allowlist')).toEqual([])
})
