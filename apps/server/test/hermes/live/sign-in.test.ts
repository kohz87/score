import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { SignInSchema } from '@score/contract'
import {
  signInShape,
  spawnHermes,
  type HermesChild,
  type HermesSpawner,
  type SpawnOptions,
} from '../../../src/hermes/live/cli.ts'
import { LiveSettings } from '../../../src/hermes/live/settings.ts'
import { parseDeviceCode, SignInManager } from '../../../src/hermes/live/sign-in.ts'

const CODEX_OUTPUT = `Signing in to OpenAI Codex...
(Hermes creates its own session — won't affect Codex CLI or VS Code)

To continue, follow these steps:

  1. Open this URL in your browser:
     \u001b[94mhttps://auth.openai.com/codex/device\u001b[0m

  2. Enter this code:
     \u001b[94mABCD-EFGH1\u001b[0m

Waiting for sign-in... (press Ctrl+C to cancel)
`
const NOUS_OUTPUT = `Starting Hermes login via Nous Portal...
Portal: https://portal.nousresearch.com

To continue:
  1. Open: https://portal.nousresearch.com/device?user_code=WDJB-MJHT
  2. If prompted, enter code: WDJB-MJHT
Waiting for approval (polling every 5s)...
`

test('the device-code parser reads Codex and Nous output, ignores Portal lines, needs both parts', () => {
  expect(parseDeviceCode(CODEX_OUTPUT)).toEqual({
    url: 'https://auth.openai.com/codex/device',
    code: 'ABCD-EFGH1',
  })
  expect(parseDeviceCode(NOUS_OUTPUT)).toEqual({
    url: 'https://portal.nousresearch.com/device?user_code=WDJB-MJHT',
    code: 'WDJB-MJHT',
  })
  // Partial output (the code has not arrived yet) is not a result.
  expect(parseDeviceCode(CODEX_OUTPUT.slice(0, CODEX_OUTPUT.indexOf('2. Enter')))).toBeNull()
  expect(
    parseDeviceCode('Open: http://insecure.example/device\n enter code: ABCD-1234\n'),
  ).toBeNull()
  expect(parseDeviceCode('Open: https://x.example/d\n enter code: <script>\n')).toBeNull()
})

test('only the exact sign-in argv shapes may be spawned', () => {
  expect(signInShape(['auth', 'add', 'nous', '--type', 'oauth', '--no-browser'])).toBe(
    'device_code',
  )
  expect(
    signInShape([
      '-p',
      'scoretesta',
      'auth',
      'add',
      'openrouter',
      '--type',
      'api-key',
      '--label',
      'a b',
    ]),
  ).toBe('api_key')
  expect(
    signInShape(['auth', 'add', 'openrouter', '--type', 'api-key', '--label', '-x']),
  ).toBeNull()
  expect(signInShape(['auth', 'add', 'openrouter', '--api-key', 'sk-secret'])).toBeNull()
  expect(signInShape(['auth', 'remove', 'openrouter', '1'])).toBeNull()
  expect(() => spawnHermes(['auth', 'list'], {})).toThrow()
  // The key shape needs stdin; the device shape never takes it.
  expect(() =>
    spawnHermes(['auth', 'add', 'nous', '--type', 'oauth', '--no-browser'], { input: 'x' }),
  ).toThrow()
})

interface Fake extends HermesChild {
  argv: string[]
  options: SpawnOptions
  emit(text: string): void
  exit(code: number): void
  kills: number
}
let children: Fake[]
const spawn: HermesSpawner = (argv, options) => {
  let exit!: (code: number) => void
  const exited = new Promise<number>((resolve) => (exit = resolve))
  const child: Fake = {
    argv,
    options,
    exited,
    kills: 0,
    kill() {
      child.kills++
      exit(-1)
    },
    emit: (text) => options.onStdout?.(text),
    exit,
  }
  children.push(child)
  return child
}
let connected: boolean
const manager = (extra: Partial<ConstructorParameters<typeof SignInManager>[0]> = {}) =>
  new SignInManager({
    spawn,
    hermesHome: '/h',
    profileArgs: [],
    isConnected: async () => connected,
    ...extra,
  })
beforeEach(() => {
  children = []
  connected = true
})
afterEach(() => vi.useRealTimers())

test('a sign-in shows the link and code, then connects only when auth list says so', async () => {
  const signIns = manager()
  const started = signIns.start('openai-codex')
  expect(children[0]!.argv).toEqual([
    'auth',
    'add',
    'openai-codex',
    '--type',
    'oauth',
    '--no-browser',
  ])
  children[0]!.emit(CODEX_OUTPUT.slice(0, 60))
  children[0]!.emit(CODEX_OUTPUT.slice(60))
  const signIn = await started
  expect(SignInSchema.parse(signIn)).toMatchObject({
    state: 'waiting',
    url: 'https://auth.openai.com/codex/device',
    code: 'ABCD-EFGH1',
  })
  // One sign-in per provider: a second start returns the waiting one.
  expect((await signIns.start('openai-codex')).id).toBe(signIn.id)
  expect(children).toHaveLength(1)
  children[0]!.exit(0)
  await vi.waitFor(() => expect(signIns.get(signIn.id).state).toBe('connected'))
  expect(signIns.get(signIn.id)).toMatchObject({ url: null, code: null, message: null })
  expect(() => signIns.get('nope')).toThrow(expect.objectContaining({ status: 404 }))
})

test('exit 0 without a connected provider, or a non-zero exit, is a generic failure', async () => {
  const signIns = manager()
  for (const [code, ok] of [
    [0, false],
    [1, true],
  ] as const) {
    connected = ok
    const started = signIns.start(`p${code}`)
    children.at(-1)!.emit(NOUS_OUTPUT)
    const signIn = await started
    children.at(-1)!.emit('raw secret-looking output sk-should-not-leak')
    children.at(-1)!.exit(code)
    await vi.waitFor(() => expect(signIns.get(signIn.id).state).toBe('failed'))
    expect(JSON.stringify(signIns.get(signIn.id))).not.toContain('sk-should-not-leak')
  }
})

test('cancel kills the child by handle; close kills the rest; expiry and parse timeout end it', async () => {
  vi.useFakeTimers()
  const signIns = manager({ parseTimeoutMs: 1000, expiryMs: 60_000 })
  const a = signIns.start('a')
  children[0]!.emit(NOUS_OUTPUT)
  const first = await a
  expect(signIns.cancel(first.id).state).toBe('cancelled')
  expect(children[0]!.kills).toBe(1)
  // Cancelling again is harmless, and a cancelled provider can start again.
  expect(signIns.cancel(first.id).state).toBe('cancelled')
  expect(children[0]!.kills).toBe(1)

  const b = signIns.start('b')
  children[1]!.emit(NOUS_OUTPUT)
  const second = await b
  await vi.advanceTimersByTimeAsync(60_000)
  expect(signIns.get(second.id)).toMatchObject({ state: 'expired', url: null })
  expect(children[1]!.kills).toBe(1)

  const c = signIns.start('c')
  children[2]!.emit('nothing useful')
  await vi.advanceTimersByTimeAsync(1000)
  expect((await c).state).toBe('failed')
  expect(children[2]!.kills).toBe(1)

  const d = signIns.start('d')
  children[3]!.emit(NOUS_OUTPUT)
  const open = await d
  signIns.close()
  expect(children[3]!.kills).toBe(1)
  expect(signIns.get(open.id).state).toBe('cancelled')
})

test('output is bounded: a flood without a code gives up instead of growing', async () => {
  vi.useFakeTimers()
  const signIns = manager({ parseTimeoutMs: 500 })
  const started = signIns.start('flood')
  for (let i = 0; i < 100; i++) children[0]!.emit('x'.repeat(4096))
  await vi.advanceTimersByTimeAsync(500)
  expect((await started).state).toBe('failed')
})

let home: string
beforeEach(() => {
  home = fs.mkdtempSync(join(tmpdir(), 'score-signin-'))
})
afterEach(() => fs.rmSync(home, { recursive: true, force: true }))
const KEY = 'sk-score-test-not-real-0000'
const runner = (listing: () => string) =>
  vi.fn(async (args: string[]) =>
    args.join(' ').endsWith('auth list') ? { exitCode: 0, stdout: listing() } : { exitCode: 0 },
  )

test('connect starts a device sign-in for device-code providers and a terminal command for the rest', async () => {
  const catalog = async () => [
    { slug: 'nous', name: 'Nous Portal', auth_type: 'oauth_device_code' },
    { slug: 'openrouter', name: 'OpenRouter', auth_type: 'api_key' },
    { slug: 'anthropic', name: 'Anthropic' },
    { slug: 'qwen-oauth', name: 'Qwen', auth_type: 'oauth_external' },
  ]
  const settings = new LiveSettings(
    home,
    runner(() => ''),
    catalog,
    'scoretesta',
    spawn,
  )
  const items = await settings.listProviders()
  expect(Object.fromEntries(items.map((item) => [item.id, item.signIn]))).toEqual({
    nous: 'device_code',
    openrouter: 'api_key',
    // No auth_type from Hermes, but it takes a console key.
    anthropic: 'api_key',
    'qwen-oauth': 'terminal',
  })
  const started = settings.connectProvider('nous')
  await vi.waitFor(() => expect(children).toHaveLength(1))
  expect(children[0]!.argv).toEqual([
    '-p',
    'scoretesta',
    'auth',
    'add',
    'nous',
    '--type',
    'oauth',
    '--no-browser',
  ])
  children[0]!.emit(NOUS_OUTPUT)
  const result = await started
  expect(result).toMatchObject({
    next: 'device_code',
    command: 'hermes auth add nous',
    url: 'https://portal.nousresearch.com/device?user_code=WDJB-MJHT',
    code: 'WDJB-MJHT',
  })
  expect((await settings.cancelSignIn(result.signInId!)).state).toBe('cancelled')
  expect((await settings.connectProvider('qwen-oauth')).next).toBe('run_in_terminal')
  expect(children).toHaveLength(1)
  settings.close()
})

test('a pasted key goes to stdin only, then is verified through auth list', async () => {
  let listing = ''
  const catalog = async () => [
    { slug: 'openrouter', name: 'OpenRouter', auth_type: 'api_key' },
    { slug: 'nous', name: 'Nous Portal', auth_type: 'oauth_device_code' },
  ]
  const run = runner(() => listing)
  const settings = new LiveSettings(home, run, catalog, undefined, spawn)
  const pending = settings.addProviderKey('openrouter', { apiKey: KEY, label: 'work' })
  await vi.waitFor(() => expect(children).toHaveLength(1))
  const child = children[0]!
  expect(child.argv).toEqual(['auth', 'add', 'openrouter', '--type', 'api-key', '--label', 'work'])
  expect(child.options.input).toBe(`${KEY}\n`)
  expect(JSON.stringify([child.argv, run.mock.calls])).not.toContain(KEY)
  listing = 'openrouter (1 credentials):\n  #1  work   api_key id=abc123 priority=0 manual\n'
  child.exit(0)
  await expect(pending).resolves.toMatchObject({
    id: 'openrouter',
    status: 'connected',
    signIn: 'api_key',
  })

  // Not a key provider, unknown, or Hermes did not confirm.
  await expect(settings.addProviderKey('nous', { apiKey: KEY })).rejects.toMatchObject({
    status: 409,
  })
  await expect(settings.addProviderKey('nope', { apiKey: KEY })).rejects.toMatchObject({
    status: 404,
  })
  listing = ''
  const failing = settings.addProviderKey('openrouter', { apiKey: KEY })
  await vi.waitFor(() => expect(children).toHaveLength(2))
  expect(children[1]!.argv.at(-1)).toMatch(/^score-\d{4}-\d{2}-\d{2}$/)
  children[1]!.exit(0)
  await expect(failing).rejects.toMatchObject({ status: 409, code: 'not_verified' })
})

test('close stops a running key child and refuses sign-ins whose catalog read finishes after it', async () => {
  let release!: () => void
  const gate = new Promise<void>((resolve) => (release = resolve))
  const catalog = async () => {
    await gate
    return [
      { slug: 'openrouter', name: 'OpenRouter', auth_type: 'api_key' },
      { slug: 'nous', name: 'Nous Portal', auth_type: 'oauth_device_code' },
    ]
  }
  const settings = new LiveSettings(
    home,
    runner(() => ''),
    catalog,
    undefined,
    spawn,
  )
  release()
  const adding = settings.addProviderKey('openrouter', { apiKey: KEY })
  await vi.waitFor(() => expect(children).toHaveLength(1))
  let lateRelease!: () => void
  const late = new Promise<void>((resolve) => (lateRelease = resolve))
  const slow = new LiveSettings(
    home,
    runner(() => ''),
    async () => {
      await late
      return [{ slug: 'nous', name: 'Nous Portal', auth_type: 'oauth_device_code' }]
    },
    undefined,
    spawn,
  )
  const connecting = slow.connectProvider('nous')
  settings.close()
  slow.close()
  expect(children[0]!.kills).toBe(1)
  await expect(adding).rejects.toMatchObject({ status: 409 })
  lateRelease()
  await expect(connecting).rejects.toMatchObject({ status: 503 })
  // No sign-in child was started after close.
  expect(children).toHaveLength(1)
})

// A stand-in `hermes` on PATH: records argv, environment and stdin so the real spawn can be checked end to end.
test('spawnHermes runs detached with stdin closed or fed, and the key never reaches argv or env', async () => {
  const bin = join(home, 'bin')
  fs.mkdirSync(bin)
  const out = join(home, 'seen.txt')
  fs.writeFileSync(
    join(bin, 'hermes'),
    `#!/bin/sh\n{ echo "ARGV:$*"; env; echo "SID:$(ps -o sid= -p $$ | tr -d ' ') PID:$$"; echo "STDIN:$(cat)"; } > "${out}"\n` +
      `echo "Open: https://example.com/device"; echo "enter code: ABCD-1234"\n`,
    { mode: 0o755 },
  )
  const previous = process.env.PATH
  process.env.PATH = `${bin}:${previous}`
  try {
    let seen = ''
    const child = spawnHermes(['auth', 'add', 'openrouter', '--type', 'api-key', '--label', 'x'], {
      hermesHome: home,
      input: `${KEY}\n`,
      onStdout: (chunk) => (seen += chunk),
    })
    expect(await child.exited).toBe(0)
    expect(parseDeviceCode(seen)).toEqual({ url: 'https://example.com/device', code: 'ABCD-1234' })
    const recorded = fs.readFileSync(out, 'utf8')
    expect(recorded).toContain('ARGV:-p default auth add openrouter --type api-key --label x')
    expect(recorded).toContain(`STDIN:${KEY}`)
    expect(recorded.replace(`STDIN:${KEY}`, '')).not.toContain(KEY)
    const [, sid, pid] = /SID:(\d+) PID:(\d+)/.exec(recorded)!
    expect(sid).toBe(pid) // its own session: no controlling terminal
    expect(recorded).toContain(`HERMES_HOME=${home}`)

    const device = spawnHermes(['auth', 'add', 'nous', '--type', 'oauth', '--no-browser'], {
      hermesHome: home,
    })
    expect(await device.exited).toBe(0)
    expect(fs.readFileSync(out, 'utf8')).toContain('STDIN:\n')
  } finally {
    process.env.PATH = previous
  }
})
