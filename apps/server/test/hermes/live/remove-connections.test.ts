import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { LiveAgentTabs } from '../../../src/hermes/live/agent-tabs.ts'
import { runHermes, type CliOptions, type HermesRunner } from '../../../src/hermes/live/cli.ts'
import { removeMessagingValues } from '../../../src/hermes/live/messaging.ts'
import { ProfileLocks } from '../../../src/hermes/live/profile-locks.ts'
import { ProfilesReader } from '../../../src/hermes/live/profiles.ts'
import { credentialIds, LiveSettings } from '../../../src/hermes/live/settings.ts'
import { removeProviderAcross } from '../../../src/hermes/live/remove-provider.ts'
import { HttpError } from '../../../src/errors.ts'

// 2.0.3: removing connections and sharing local providers. Exact argv only; no key material is ever read.
const authList = (providers: Record<string, string[]>) =>
  Object.entries(providers)
    .map(
      ([provider, ids]) =>
        `${provider} (${ids.length} credentials):\n` +
        ids
          .map((id, at) => `  #${at + 1}  label${at}   api_key id=${id} priority=${at} manual`)
          .join('\n'),
    )
    .join('\n\n') + '\n\nnous: Free tier\n  Upgrade with hermes portal\n'

let home: string
let auth: Record<string, string[]>
let mcp: Record<string, unknown>
let providers: Record<string, Record<string, Record<string, string>>>
const runner = vi.fn<HermesRunner>()
const argvs = () => runner.mock.calls.map(([args]) => args)

beforeEach(() => {
  home = fs.mkdtempSync(join(tmpdir(), 'score-remove-'))
  fs.mkdirSync(join(home, 'profiles', 'builder'), { recursive: true })
  auth = { openrouter: ['abc123'], anthropic: ['def456', '0a1b2c'] }
  mcp = { files: { command: 'npx' }, broken: { note: 'x' } }
  providers = {
    default: {
      'lab-gpu': { name: 'Lab GPU', base_url: 'http://10.0.0.5:8080/v1', default_model: 'llama-3' },
    },
    builder: {},
  }
  runner.mockReset().mockImplementation(async (args) => {
    const scoped = args[0] === '-p'
    const profile = scoped ? args[1]! : 'default'
    const rest = scoped ? args.slice(2) : args
    const key = rest.join(' ')
    if (key === 'auth list') return { exitCode: 0, stdout: authList(auth) }
    if (rest[0] === 'auth' && rest[1] === 'remove') {
      auth[rest[2]!] = (auth[rest[2]!] ?? []).filter((id) => id !== rest[3])
      if (auth[rest[2]!]!.length === 0) delete auth[rest[2]!]
      return { exitCode: 0 }
    }
    if (key === 'config get --json mcp_servers') return { exitCode: 0, stdout: JSON.stringify(mcp) }
    if (rest[0] === 'mcp' && rest[1] === 'remove') {
      delete mcp[rest[2]!]
      return { exitCode: 0 }
    }
    if (key === 'config get --json providers') {
      const own = providers[profile] ?? {}
      return Object.keys(own).length
        ? { exitCode: 0, stdout: JSON.stringify(own) }
        : { exitCode: 1 }
    }
    const set = /^config set providers\.([^.]+)\.(\w+) (.*)$/.exec(key)
    if (set) {
      const own = (providers[profile] ??= {})
      own[set[1]!] = { ...own[set[1]!], [set[2]!]: set[3]! }
      return { exitCode: 0 }
    }
    const unset = /^config unset providers\.(.+)$/.exec(key)
    if (unset) {
      delete providers[profile]?.[unset[1]!]
      return { exitCode: 0 }
    }
    return { exitCode: 0 }
  })
})
afterEach(() => fs.rmSync(home, { recursive: true, force: true }))

function tabs() {
  const reader = new ProfilesReader(home, runner)
  return new LiveAgentTabs(
    home,
    (profile) => reader.profileHome(profile),
    (profile) => reader.invalidate(profile),
    runner,
  )
}

test('credential ids are read from one provider section only', () => {
  const text = authList(auth)
  expect(credentialIds(text, 'anthropic')).toEqual(['def456', '0a1b2c'])
  expect(credentialIds(text, 'openrouter')).toEqual(['abc123'])
  expect(credentialIds(text, 'nous')).toEqual([])
})

test('a hosted provider loses each stored credential, verified by a fresh auth list', async () => {
  await new LiveSettings(home, runner).removeHostedProvider('anthropic')
  expect(argvs().filter((args) => args[1] === 'remove')).toEqual([
    ['auth', 'remove', 'anthropic', 'def456'],
    ['auth', 'remove', 'anthropic', '0a1b2c'],
  ])
  expect(auth.anthropic).toBeUndefined()
  expect(auth.openrouter).toEqual(['abc123'])
  const reads = runner.mock.calls.filter(([args]) => args.join(' ') === 'auth list')
  expect(reads.every(([, options]) => options.fresh === true)).toBe(true)
})

test('a sign-in that survives `auth remove` gets `auth logout`, then 409 when still listed', async () => {
  const base = runner.getMockImplementation()!
  runner.mockImplementation(async (args, options) =>
    args[0] === 'auth' && args[1] === 'remove' ? { exitCode: 0 } : base(args, options),
  )
  await expect(
    new LiveSettings(home, runner).removeHostedProvider('openrouter'),
  ).rejects.toMatchObject({
    status: 409,
    code: 'not_verified',
  })
  expect(argvs()).toContainEqual(['auth', 'logout', 'openrouter'])
})

test('a provider with nothing stored is not_supported', async () => {
  await expect(new LiveSettings(home, runner).removeHostedProvider('nous')).rejects.toMatchObject({
    status: 409,
    code: 'not_supported',
  })
  expect(argvs().some((args) => args[1] === 'remove' || args[1] === 'logout')).toBe(false)
})

test('a tool server goes through `mcp remove` with stdin closed, verified gone', async () => {
  await new LiveSettings(home, runner).removeToolServer('files')
  const call = runner.mock.calls.find(([args]) => args[0] === 'mcp')!
  expect(call[0]).toEqual(['mcp', 'remove', 'files'])
  expect(call[1].closeStdin).toBe(true)
  expect(mcp).not.toHaveProperty('files')
  await expect(new LiveSettings(home, runner).removeToolServer('missing')).rejects.toMatchObject({
    status: 404,
  })
})

test('a tool server Hermes kept is a 409', async () => {
  const base = runner.getMockImplementation()!
  runner.mockImplementation(async (args, options) =>
    args[0] === 'mcp' ? { exitCode: 0 } : base(args, options),
  )
  await expect(new LiveSettings(home, runner).removeToolServer('files')).rejects.toMatchObject({
    status: 409,
    code: 'not_verified',
  })
})

test('the runner closes stdin only when asked', async () => {
  const end = vi.fn()
  const execute = vi.fn<NonNullable<CliOptions['execute']>>((_f, _a, _o, callback) => {
    queueMicrotask(() => callback(null, ''))
    return { stdin: { end, on: vi.fn() } }
  })
  await runHermes(['mcp', 'remove', 'files'], { timeoutMs: 1000, execute, closeStdin: true })
  expect(end).toHaveBeenCalledTimes(1)
  await runHermes(['config', 'set', 'a', 'b'], { timeoutMs: 1000, execute })
  expect(end).toHaveBeenCalledTimes(1)
})

test('a messaging platform is cleared key by key; nothing removed is a 409', async () => {
  const locks = new ProfileLocks()
  const row = await removeMessagingValues({
    hermesHome: home,
    profile: 'builder',
    platform: 'telegram',
    keys: ['TELEGRAM_BOT_TOKEN', 'TELEGRAM_ALLOWED_USERS'],
    runner,
    locks,
  })
  expect(argvs()).toEqual([
    ['-p', 'builder', 'config', 'unset', 'TELEGRAM_BOT_TOKEN'],
    ['-p', 'builder', 'config', 'unset', 'TELEGRAM_ALLOWED_USERS'],
  ])
  expect(row).toMatchObject({ platform: 'telegram', status: 'disconnected' })
  runner.mockImplementation(async () => ({ exitCode: 1 }))
  await expect(
    removeMessagingValues({
      hermesHome: home,
      profile: undefined,
      platform: 'telegram',
      keys: ['TELEGRAM_BOT_TOKEN'],
      runner,
      locks,
    }),
  ).rejects.toMatchObject({ status: 409 })
})

test('a local provider is copied into another profile: name, address and default model only', async () => {
  await tabs().copyLocalProvider('builder', 'lab-gpu')
  expect(argvs().filter((args) => args[3] === 'set')).toEqual([
    ['-p', 'builder', 'config', 'set', 'providers.lab-gpu.base_url', 'http://10.0.0.5:8080/v1'],
    ['-p', 'builder', 'config', 'set', 'providers.lab-gpu.name', 'Lab GPU'],
    ['-p', 'builder', 'config', 'set', 'providers.lab-gpu.default_model', 'llama-3'],
  ])
  // Already there: no second copy.
  runner.mockClear()
  await tabs().copyLocalProvider('builder', 'lab-gpu')
  expect(argvs().some((args) => args[3] === 'set')).toBe(false)
})

test('choosing a local provider the agent lacks copies it before setting the model', async () => {
  const base = runner.getMockImplementation()!
  runner.mockImplementation(async (args, options) =>
    args.slice(2).join(' ') === 'config get --json model'
      ? { exitCode: 0, stdout: JSON.stringify({ default: 'old', provider: 'openrouter' }) }
      : base(args, options),
  )
  await tabs().setModel('builder', { model: 'llama-3', provider: 'lab-gpu' })
  const writes = argvs()
    .filter((args) => args[3] === 'set')
    .map((args) => args[4])
  expect(writes.slice(0, 3)).toEqual([
    'providers.lab-gpu.base_url',
    'providers.lab-gpu.name',
    'providers.lab-gpu.default_model',
  ])
  expect(writes).toContain('model.default')
  expect(providers.builder).toHaveProperty('lab-gpu')
})

test('removing a local provider unsets the full key; a dotted id is refused', async () => {
  await tabs().removeLocalProvider('default', 'lab-gpu')
  expect(argvs()).toContainEqual(['-p', 'default', 'config', 'unset', 'providers.lab-gpu'])
  expect(argvs().some((args) => args.join(' ').endsWith('config unset providers'))).toBe(false)
  await expect(tabs().removeLocalProvider('default', 'a.b')).rejects.toThrow()
})

test('a tool server whose removal can’t be checked is not reported as removed', async () => {
  const base = runner.getMockImplementation()!
  let reads = 0
  runner.mockImplementation(async (args, options) =>
    args.join(' ') === 'config get --json mcp_servers' && ++reads > 1
      ? { exitCode: -1 }
      : base(args, options),
  )
  await expect(new LiveSettings(home, runner).removeToolServer('files')).rejects.toMatchObject({
    status: 502,
  })
})

test('the stdin of a closed-stdin command gets an error handler before it is ended', async () => {
  const order: string[] = []
  const stdin = { on: vi.fn(() => order.push('on')), end: vi.fn(() => order.push('end')) }
  const execute = vi.fn<NonNullable<CliOptions['execute']>>((_f, _a, _o, callback) => {
    queueMicrotask(() => callback(null, ''))
    return { stdin }
  })
  await runHermes(['mcp', 'remove', 'files'], { timeoutMs: 1000, execute, closeStdin: true })
  expect(order).toEqual(['on', 'end'])
})

describe('removing a provider across profiles', () => {
  const deps = (defines: Record<string, boolean | null>, hosted: () => Promise<void>) => ({
    profiles: Object.keys(defines),
    defines: vi.fn(async (profile: string) => defines[profile]!),
    removeLocal: vi.fn(async () => undefined),
    removeHosted: vi.fn(hosted),
  })
  const nothingStored = async () => {
    throw new HttpError(409, 'not_supported', 'Nothing is stored for this provider.')
  }
  test('a local provider leaves every profile that has it; nothing stored is fine', async () => {
    const d = deps({ default: true, builder: true, reviewer: false }, nothingStored)
    await removeProviderAcross('lab-gpu', d)
    expect(d.removeLocal.mock.calls).toEqual([
      ['default', 'lab-gpu'],
      ['builder', 'lab-gpu'],
    ])
    expect(d.removeHosted).toHaveBeenCalledWith('lab-gpu')
  })
  test('one unreadable profile stops the removal before anything changes', async () => {
    const d = deps({ default: true, builder: null }, async () => undefined)
    await expect(removeProviderAcross('lab-gpu', d)).rejects.toMatchObject({ status: 502 })
    expect(d.removeLocal).not.toHaveBeenCalled()
    expect(d.removeHosted).not.toHaveBeenCalled()
  })
  test('a hosted provider goes to the credential path; its refusal is passed on', async () => {
    const d = deps({ default: false, builder: false }, nothingStored)
    await expect(removeProviderAcross('openrouter', d)).rejects.toMatchObject({
      code: 'not_supported',
    })
    expect(d.removeLocal).not.toHaveBeenCalled()
  })
  test('local entries and stored credentials under one id are both removed', async () => {
    const d = deps({ default: true }, async () => undefined)
    await removeProviderAcross('dual', d)
    expect(d.removeLocal).toHaveBeenCalledTimes(1)
    expect(d.removeHosted).toHaveBeenCalledTimes(1)
  })
})

describe('local provider keys (2.0.10)', () => {
  test('a key is written as an argv element marked sensitive, never captured', async () => {
    await tabs().setLocalProviderKey('builder', 'lab-gpu', 'sk-local-secret-1')
    const call = runner.mock.calls.find(([args]) => args.includes('providers.lab-gpu.api_key'))!
    expect(call[0]).toEqual([
      '-p',
      'builder',
      'config',
      'set',
      'providers.lab-gpu.api_key',
      'sk-local-secret-1',
    ])
    expect(call[1].sensitiveArgIndices).toEqual([5])
    expect(call[1].captureRead || call[1].captureSettings).toBeFalsy()
  })
  test('copying a keyed provider is refused with needs_key unless the key follows', async () => {
    providers.default!['lab-gpu']!.api_key = '***'
    await expect(tabs().copyLocalProvider('builder', 'lab-gpu')).rejects.toMatchObject({
      status: 409,
      code: 'needs_key',
    })
    // The address is there; the key isn't (Hermes masks it on read).
    expect(providers.builder).toHaveProperty('lab-gpu')
    expect(argvs().some((args) => args.includes('providers.lab-gpu.api_key'))).toBe(false)
    delete providers.builder!['lab-gpu']
    await tabs().copyLocalProvider('builder', 'lab-gpu', 'default', true)
    expect(providers.builder).toHaveProperty('lab-gpu')
  })
  test('an env placeholder key is copied as it is', async () => {
    providers.default!['lab-gpu']!.api_key = '${LAB_KEY}'
    await tabs().copyLocalProvider('builder', 'lab-gpu')
    expect(argvs()).toContainEqual([
      '-p',
      'builder',
      'config',
      'set',
      'providers.lab-gpu.api_key',
      '${LAB_KEY}',
    ])
  })
  test('choosing a keyed provider whose earlier copy lacks the key says so', async () => {
    providers.default!['lab-gpu']!.api_key = '***'
    providers.builder = { 'lab-gpu': { name: 'Lab GPU', base_url: 'http://10.0.0.5:8080/v1' } }
    const base = runner.getMockImplementation()!
    runner.mockImplementation(async (args, options) =>
      args.slice(2).join(' ') === 'config get --json model'
        ? { exitCode: 0, stdout: JSON.stringify({ default: 'old', provider: 'openrouter' }) }
        : base(args, options),
    )
    await expect(
      tabs().setModel('builder', { model: 'llama-3', provider: 'lab-gpu' }),
    ).rejects.toMatchObject({ status: 409, code: 'needs_key' })
    expect(argvs().some((args) => args.includes('model.default'))).toBe(false)
  })
  test('the local list says whether a key is set, never what it is', async () => {
    const local: Record<string, Record<string, string>> = {
      'lab-gpu': { name: 'Lab GPU', base_url: 'http://10.0.0.5:8080/v1', api_key: '***' },
      bare: { name: 'Bare', base_url: 'http://10.0.0.6:8080/v1' },
    }
    runner.mockImplementation(async (args) =>
      args.join(' ') === 'config get --json providers'
        ? { exitCode: 0, stdout: JSON.stringify(local) }
        : args.join(' ') === 'auth list'
          ? { exitCode: 0, stdout: '' }
          : { exitCode: 0 },
    )
    const items = await new LiveSettings(home, runner).listProviders()
    expect(items.find((item) => item.id === 'lab-gpu')).toMatchObject({ keySet: true })
    expect(items.find((item) => item.id === 'bare')).toMatchObject({ keySet: false })
    expect(JSON.stringify(items)).not.toContain('***')
  })
  test('adding a local provider with a key writes it last, marked sensitive', async () => {
    await new LiveSettings(home, runner).addLocalProvider({
      label: 'Keyed',
      baseUrl: 'http://10.0.0.7:8080/v1',
      model: 'm',
      apiKey: 'sk-keyed-123',
    })
    const call = runner.mock.calls.find(([args]) => args.includes('providers.keyed.api_key'))!
    expect(call[0].at(-1)).toBe('sk-keyed-123')
    expect(call[1].sensitiveArgIndices).toEqual([call[0].length - 1])
  })
})

test('local provider ids: unset is none, a failed read is unknown (2.0.10)', async () => {
  const settings = new LiveSettings(home, runner)
  expect(await settings.localProviderIds()).toEqual(new Set(['lab-gpu']))
  runner.mockImplementation(async () => ({ exitCode: 1 }))
  expect(await settings.localProviderIds()).toEqual(new Set())
  runner.mockImplementation(async () => ({ exitCode: -1 }))
  expect(await settings.localProviderIds()).toBeNull()
})
