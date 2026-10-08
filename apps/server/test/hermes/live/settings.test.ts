import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { ConnectionsResponseSchema, ProviderItemSchema } from '@score/contract'
import { HttpError } from '../../../src/errors.ts'
import { runHermes, type CliOptions, type HermesRunner } from '../../../src/hermes/live/cli.ts'
import { LiveSettings } from '../../../src/hermes/live/settings.ts'

const SECRET = 'sk-or-v1-planted-secret-value-1234567890'
const AUTH_LIST = `openrouter (1 credentials):
  #1  OPENROUTER_API_KEY   api_key id=abc123 priority=0 env:OPENROUTER_API_KEY ←

anthropic (2 credentials):
  #1  work                 oauth   id=def456 priority=0 manual auth failed (401) (re-auth may be required)
  #2  home                 oauth   id=0a1b2c priority=1 manual auth failed (re-auth may be required)

openai-codex (1 credentials):
  #1  chatgpt              oauth   id=cd34ef priority=0 device_code ←

nous: Free tier
  Upgrade with hermes portal
`
const MCP = {
  files: { command: 'npx', args: ['-y', 'files-server'], env: { API_TOKEN: SECRET } },
  'web-search': {
    url: 'https://mcp.example.com/sse',
    headers: { Authorization: `Bearer ${SECRET}` },
  },
  broken: { note: 'no launch target' },
}
const LOCAL = {
  'my-proxy': { name: 'My proxy', base_url: 'http://127.0.0.1:4000/v1', api_key: '***' },
}
let home: string
const runner = vi.fn<HermesRunner>()
beforeEach(() => {
  home = fs.mkdtempSync(join(tmpdir(), 'score-settings-'))
  fs.writeFileSync(join(home, '.env'), `OPENROUTER_API_KEY=${SECRET}\n`)
  fs.writeFileSync(join(home, 'auth.json'), JSON.stringify({ token: SECRET }))
  fs.writeFileSync(
    join(home, 'gateway_state.json'),
    JSON.stringify({
      served_profiles: ['lead'],
      platforms: {
        telegram: { state: 'connected', token: SECRET },
        'lead:slack': {
          state: 'retrying',
          error_code: 'auth_failed',
          error_message: `bad ${SECRET}`,
        },
      },
    }),
  )
  runner.mockReset().mockImplementation(async (args) => {
    const key = args.join(' ')
    if (key === 'auth list') return { exitCode: 0, stdout: AUTH_LIST }
    if (key === 'config get --json mcp_servers') return { exitCode: 0, stdout: JSON.stringify(MCP) }
    if (key === 'config get --json providers') return { exitCode: 0, stdout: JSON.stringify(LOCAL) }
    return { exitCode: 0 }
  })
})
afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(home, { recursive: true, force: true })
})

test('providers come from `hermes auth list` with statuses, details and no key material', async () => {
  const items = await new LiveSettings(home, runner).listProviders()
  expect(
    items
      .map((item) => ({ ...item, usedBy: [] }))
      .every((i) => ProviderItemSchema.safeParse(i).success),
  ).toBe(true)
  const byId = Object.fromEntries(items.map((item) => [item.id, item]))
  expect(byId.openrouter).toMatchObject({ status: 'connected', detail: 'API key (1)' })
  expect(byId.anthropic).toMatchObject({ status: 'needs_signin', detail: 'Signed in' })
  expect(byId['openai-codex']).toMatchObject({ status: 'connected', detail: 'Your ChatGPT plan' })
  expect(byId.nous).toMatchObject({ status: 'connected', detail: 'Free tier' })
  expect(byId['my-proxy']).toMatchObject({ label: 'My proxy', detail: '127.0.0.1:4000' })
  expect(JSON.stringify(items)).not.toContain(SECRET)
  expect(runner).toHaveBeenCalledWith(['auth', 'list'], {
    timeoutMs: 8000,
    hermesHome: home,
    captureSettings: true,
  })
})
test('a missing credential store reads as missing providers, not an error', async () => {
  runner.mockResolvedValue({ exitCode: 1 })
  const items = await new LiveSettings(home, runner).listProviders()
  expect(items.map((item) => [item.id, item.status])).toEqual([
    ['openrouter', 'missing'],
    ['anthropic', 'missing'],
    ['openai-codex', 'missing'],
    ['nous', 'missing'],
  ])
})
test('connections: tool servers from config (launch target only) and messaging from gateway state', async () => {
  const connections = ConnectionsResponseSchema.parse(
    await new LiveSettings(home, runner).listConnections(),
  )
  expect(connections.toolServers).toEqual([
    { id: 'files', label: 'files', status: 'ok', usedBy: 'everyone' },
    { id: 'web-search', label: 'web-search', status: 'ok', usedBy: 'everyone' },
    { id: 'broken', label: 'broken', status: 'error', usedBy: 'everyone' },
  ])
  const byPlatform = Object.fromEntries(connections.messaging.map((row) => [row.platform, row]))
  expect(byPlatform.telegram).toMatchObject({ status: 'connected', detail: null })
  expect(byPlatform.slack).toMatchObject({ status: 'disconnected', detail: 'auth_failed' })
  expect(byPlatform.discord).toMatchObject({ status: 'disconnected', detail: null })
  expect(JSON.stringify(connections)).not.toContain(SECRET)
})
test('status never opens .env, auth.json or anything but gateway_state.json (fs spy)', async () => {
  const touched: string[] = []
  const record = (path: unknown) => touched.push(String(path))
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
      record(args[0])
      return original(...args)
    }) as never)
  }
  const promises = vi.spyOn(fs.promises, 'readFile')
  const settings = new LiveSettings(home, runner)
  await settings.listProviders()
  await settings.listConnections()
  expect(touched.length).toBeGreaterThan(0)
  for (const path of touched) expect(basename(path)).toBe('gateway_state.json')
  expect(touched.join(' ')).not.toMatch(/\.env|auth\.json/)
  expect(promises).not.toHaveBeenCalled()
})
test('connect results are terminal commands; nothing interactive is spawned', async () => {
  const settings = new LiveSettings(home, runner)
  await expect(settings.connectProvider('openrouter')).resolves.toEqual({
    next: 'run_in_terminal',
    command: 'hermes auth add openrouter',
  })
  await expect(settings.connectProvider('nope')).rejects.toMatchObject({ status: 404 })
  await expect(settings.connectProvider('../x')).rejects.toBeInstanceOf(HttpError)
  expect(settings.connectMessaging('telegram')).toEqual({
    next: 'run_in_terminal',
    command: 'hermes gateway setup',
  })
  expect(() => settings.connectMessaging('Bad Name')).toThrow(HttpError)
  expect(settings.addToolServer({ name: 'files', command: ['npx', '-y', "it's"] })).toEqual({
    next: 'run_in_terminal',
    command: "hermes mcp add files --command npx --args -y 'it'\\''s'",
  })
  expect(settings.addToolServer({ name: 'docs', url: 'https://mcp.example.com/sse' }).command).toBe(
    'hermes mcp add docs --url https://mcp.example.com/sse',
  )
  expect(runner.mock.calls.filter(([args]) => args[0] === 'mcp' || args[0] === 'gateway')).toEqual(
    [],
  )
})
test('local provider writes through `hermes config set` with exact argv', async () => {
  const settings = new LiveSettings(home, runner)
  const item = await settings.addLocalProvider({
    label: 'Lab GPU',
    baseUrl: 'http://10.0.0.5:8080/v1',
    model: 'llama-3',
  })
  expect(item).toEqual({
    id: 'lab-gpu',
    label: 'Lab GPU',
    status: 'connected',
    detail: '10.0.0.5:8080',
  })
  const writes = runner.mock.calls.filter(([args]) => args[1] === 'set')
  expect(writes.map(([args]) => args)).toEqual([
    ['config', 'set', 'providers.lab-gpu.name', 'Lab GPU'],
    ['config', 'set', 'providers.lab-gpu.base_url', 'http://10.0.0.5:8080/v1'],
    ['config', 'set', 'providers.lab-gpu.default_model', 'llama-3'],
  ])
  await expect(
    settings.addLocalProvider({ label: 'OpenRouter', baseUrl: 'http://x.test/v1', model: 'm' }),
  ).rejects.toMatchObject({ status: 409 })
  await expect(
    settings.addLocalProvider({ label: '!!!', baseUrl: 'http://x.test/v1', model: 'm' }),
  ).rejects.toMatchObject({ status: 400 })
  runner.mockImplementation(async (args) => ({ exitCode: args[1] === 'set' ? 1 : 0 }))
  await expect(
    settings.addLocalProvider({ label: 'Other', baseUrl: 'http://x.test/v1', model: 'm' }),
  ).rejects.toMatchObject({ status: 502 })
})
test('the CLI runner only captures the allowlisted settings reads and caps them', async () => {
  const execute = vi.fn<NonNullable<CliOptions['execute']>>((_f, _a, _o, callback) =>
    callback(null, 'out'),
  )
  await expect(
    runHermes(['auth', 'list'], { timeoutMs: 1000, captureSettings: true, execute }),
  ).resolves.toEqual({ exitCode: 0, stdout: 'out' })
  expect(execute.mock.calls[0]![2]).toMatchObject({ maxBuffer: 256 * 1024 })
  for (const args of [['auth', 'status', 'x'], ['config', 'get', '--json', 'model'], ['status']])
    await expect(
      runHermes(args, { timeoutMs: 1000, captureSettings: true, execute }),
    ).rejects.toThrow(/restricted/)
})
