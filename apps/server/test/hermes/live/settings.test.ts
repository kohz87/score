import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { ConnectionsResponseSchema, ProviderItemSchema } from '@score/contract'
import { HttpError } from '../../../src/errors.ts'
import { runHermes, type CliOptions, type HermesRunner } from '../../../src/hermes/live/cli.ts'
import { LiveSettings } from '../../../src/hermes/live/settings.ts'
import { saveMessagingValues } from '../../../src/hermes/live/messaging.ts'
import { ProfileLocks } from '../../../src/hermes/live/profile-locks.ts'
import { messagingWrites } from '../../../src/hermes/messaging-fields.ts'

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
let local: Record<string, Record<string, string>>
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
  local = structuredClone(LOCAL)
  runner.mockReset().mockImplementation(async (args) => {
    const key = args.join(' ')
    if (key === 'auth list') return { exitCode: 0, stdout: AUTH_LIST }
    if (key === 'config get --json mcp_servers') return { exitCode: 0, stdout: JSON.stringify(MCP) }
    if (key === 'config get --json providers') return { exitCode: 0, stdout: JSON.stringify(local) }
    const set = /^config set providers\.([^.]+)\.(\w+) (.*)$/.exec(key)
    if (set) {
      local[set[1]!] = { ...local[set[1]!], [set[2]!]: set[3]! }
      return { exitCode: 0 }
    }
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
  // A local endpoint carries no sign-in kind: the web words its removal as "from every agent" (2.0.3).
  expect(byId['my-proxy']).not.toHaveProperty('signIn')
  expect(JSON.stringify(items)).not.toContain(SECRET)
  expect(runner).toHaveBeenCalledWith(['auth', 'list'], {
    timeoutMs: 20_000,
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
  // "lead:slack" belongs to the lead profile, not to the default agent these settings describe.
  expect(byPlatform.slack).toMatchObject({ status: 'disconnected', detail: null })
  const lead = await new LiveSettings(home, runner, undefined, 'lead').listConnections()
  expect(lead.messaging.find((row) => row.platform === 'slack')).toMatchObject({
    status: 'disconnected',
    detail: 'auth_failed',
  })
  expect(lead.messaging.find((row) => row.platform === 'telegram')?.status).toBe('disconnected')
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
  expect(settings.connectMessaging('telegram')).toEqual({ next: 'form' })
  expect(settings.connectMessaging('whatsapp')).toEqual({
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
test('two simultaneous additions of one name cannot overwrite each other', async () => {
  const settings = new LiveSettings(home, runner)
  const add = (baseUrl: string) => settings.addLocalProvider({ label: 'Lab', baseUrl, model: 'm' })
  const results = await Promise.allSettled([add('http://a.test/v1'), add('http://b.test/v1')])
  expect(results.map((result) => result.status).sort()).toEqual(['fulfilled', 'rejected'])
  expect(local.lab?.base_url).toBe('http://a.test/v1')
})
test('a local provider Hermes did not keep is reported as a failure', async () => {
  const base = runner.getMockImplementation()!
  runner.mockImplementation(async (args, options) =>
    args[1] === 'set' && args[2]!.endsWith('.base_url') ? { exitCode: 0 } : base(args, options),
  )
  await expect(
    new LiveSettings(home, runner).addLocalProvider({
      label: 'Lost',
      baseUrl: 'http://x.test/v1',
      model: 'm',
    }),
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

test('the provider list is every provider the gateway reports, with the short list only as a fallback', async () => {
  const catalog = async () => [
    { slug: 'nous', name: 'Nous Portal' },
    { slug: 'deepseek', name: 'DeepSeek' },
    { slug: 'gemini', name: 'Google Gemini' },
    { slug: 'custom', name: 'Custom endpoint' },
  ]
  const items = await new LiveSettings(home, runner, catalog).listProviders()
  const ids = items.map((item) => item.id)
  expect(ids).toEqual(expect.arrayContaining(['nous', 'deepseek', 'gemini']))
  expect(ids).not.toContain('custom')
  expect(items.find((item) => item.id === 'deepseek')).toMatchObject({
    label: 'DeepSeek',
    status: 'missing',
  })
  const fallback = await new LiveSettings(home, runner, async () => {
    throw new Error('gateway down')
  }).listProviders()
  expect(fallback.map((item) => item.id)).toEqual(
    expect.arrayContaining(['openrouter', 'anthropic']),
  )
  // Connect works for any listed provider and only ever hands back a terminal command.
  runner.mockClear()
  expect(await new LiveSettings(home, runner, catalog).connectProvider('deepseek')).toEqual({
    next: 'run_in_terminal',
    command: 'hermes auth add deepseek',
  })
  // Answered from the gateway catalog: no Hermes process, so Connect responds at once.
  expect(runner).not.toHaveBeenCalled()
})

test('a failed auth list keeps the last known statuses instead of showing every provider missing', async () => {
  const settings = new LiveSettings(home, runner)
  expect((await settings.listProviders()).some((item) => item.status === 'connected')).toBe(true)
  runner.mockImplementation(async () => ({ exitCode: 1 }))
  const again = await settings.listProviders()
  expect(again.some((item) => item.status === 'connected')).toBe(true)
})
test('messaging values are written with `hermes -p <profile> config set`, argv only, value marked sensitive', async () => {
  const token = '123456:planted-bot-token'
  const row = await saveMessagingValues({
    hermesHome: home,
    profile: 'lead',
    platform: 'telegram',
    writes: [['TELEGRAM_BOT_TOKEN', token]],
    runner,
    locks: new ProfileLocks(),
  })
  expect(row).toMatchObject({ platform: 'telegram' })
  const [args, options] = runner.mock.calls.find(([argv]) => argv.includes('TELEGRAM_BOT_TOKEN'))!
  expect(args).toEqual(['-p', 'lead', 'config', 'set', 'TELEGRAM_BOT_TOKEN', token])
  expect(options.sensitiveArgIndices).toEqual([5])
  // Without a profile: Hermes's default, no -p.
  await saveMessagingValues({
    hermesHome: home,
    profile: undefined,
    platform: 'telegram',
    writes: [['TELEGRAM_ALLOWED_USERS', '1']],
    runner,
    locks: new ProfileLocks(),
  })
  expect(runner.mock.calls.at(-1)![0]).toEqual(['config', 'set', 'TELEGRAM_ALLOWED_USERS', '1'])
  runner.mockImplementation(async () => ({ exitCode: 1 }))
  const failed = await saveMessagingValues({
    hermesHome: home,
    profile: undefined,
    platform: 'telegram',
    writes: [['TELEGRAM_BOT_TOKEN', token]],
    runner,
    locks: new ProfileLocks(),
  }).catch((error: HttpError) => error)
  expect(failed).toMatchObject({ status: 409 })
  expect(JSON.stringify((failed as Error).message)).not.toContain(token)
})
test('messaging writes are checked against the platform table', () => {
  expect(
    messagingWrites('telegram', { TELEGRAM_BOT_TOKEN: ' tok ', TELEGRAM_ALLOWED_USERS: '' }),
  ).toEqual([['TELEGRAM_BOT_TOKEN', 'tok']])
  expect(() => messagingWrites('telegram', { PATH: 'x', TELEGRAM_BOT_TOKEN: 't' })).toThrow(
    HttpError,
  )
  expect(() => messagingWrites('telegram', {})).toThrow(HttpError)
  expect(() => messagingWrites('whatsapp', {})).toThrow(HttpError)
})
