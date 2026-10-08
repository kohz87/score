import { mkdirSync, readFileSync, rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { AgentCreateInput, ProfileStepName } from '@score/contract'
import {
  LiveProfileManagement,
  verifyProfileArchive,
} from '../../../src/hermes/live/profile-management.ts'
import { ProfilesReader } from '../../../src/hermes/live/profiles.ts'
import { LiveAgentTabs } from '../../../src/hermes/live/agent-tabs.ts'
import { readApprovalConfig, updateProfileApprovals } from '../../../src/hermes/live/approvals.ts'
import { runHermes, type CliOptions, type HermesRunner } from '../../../src/hermes/live/cli.ts'
import type { ProfileStepContext } from '../../../src/hermes/profile-management.ts'
import { setup } from './gateway/helpers.ts'

let env: ReturnType<typeof setup>
let upstream: string
let adapter: LiveProfileManagement
let calls: string[][]
let context: ProfileStepContext
let model: string
let allowlist: string[]
let deny: string[]
let mode: string
let refuse: string | null
const pin = 'a'.repeat(40)
const source = 'https://example.invalid/score.git#hermes-plugin/score_bridge'
const input: AgentCreateInput = {
  id: 'helper',
  name: 'Helper',
  role: 'Builds small changes',
  model: 'test-model',
  style: { color: '#19C39A', shape: 'triangle' },
}
function archive(name: string) {
  const header = Buffer.alloc(512)
  header.write(`${name}/`, 0)
  header.write('0000700\0', 100)
  header.write('0000000\0', 108)
  header.write('0000000\0', 116)
  header.write('00000000000\0', 124)
  header.write('00000000000\0', 136)
  header.fill(32, 148, 156)
  header.write('5', 156)
  header.write('ustar\0', 257)
  const checksum = header.reduce((sum, byte) => sum + byte, 0)
  header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148)
  return gzipSync(Buffer.concat([header, Buffer.alloc(1024)]))
}
beforeEach(() => {
  env = setup()
  upstream = join(env.home, 'upstream')
  mkdirSync(join(upstream, 'profiles'), { recursive: true })
  calls = []
  model = 'initial'
  allowlist = ['recursive delete']
  deny = ['rm *']
  mode = 'off'
  refuse = null
  context = {
    operationId: '10000000-0000-4000-8000-000000000001',
    targetName: 'helper',
    targetIdentity: null,
    createdAt: new Date().toISOString(),
    input,
    baseline: { mode: 'smart', goAhead: [], never: ['sudo *'] },
    exportPath: null,
  }
  const runner: HermesRunner = async (args, options) => {
    const secret = args[4] === 'API_SERVER_KEY'
    calls.push(args.map((arg, index) => (secret && index === 5 ? '[redacted]' : arg)))
    if (args.includes(refuse ?? '<nothing>')) return { exitCode: 2 }
    const name = args[1]!
    const verb = args.slice(2, 4).join(' ')
    const home = join(upstream, 'profiles', 'helper')
    if (verb === 'profile create') {
      mkdirSync(home)
      writeFileSync(join(home, 'config.yaml'), 'model: initial')
      writeFileSync(
        join(home, 'profile.yaml'),
        `description: ${args[args.indexOf('--description') + 1]}`,
      )
    }
    if (verb === 'profile describe')
      writeFileSync(join(home, 'profile.yaml'), `description: ${args.at(-1)}`)
    if (verb === 'config set') {
      const key = args[4]
      const value = args[5]!
      if (key === 'API_SERVER_KEY') {
        expect(options.sensitiveArgIndices).toEqual([5])
        // The private key was durable before it was sent to the CLI.
        expect(readFileSync(join(env.home, 'hermes-keys', name), 'utf8')).toBe(value)
        expect(statSync(join(env.home, 'hermes-keys', name)).mode & 0o777).toBe(0o600)
        env.fake.keys.set(name, value)
      }
      if (key === 'model.default') model = value
      if (key === 'command_allowlist') allowlist = JSON.parse(value)
      if (key === 'approvals.deny') deny = JSON.parse(value)
      if (key === 'approvals.mode') mode = value
    }
    if (verb === 'config get') {
      const key = args.at(-1)
      const value =
        key === 'model'
          ? { default: model }
          : key === 'command_allowlist'
            ? allowlist
            : key === 'approvals'
              ? { mode, deny }
              : key === 'plugins.enabled'
                ? ['score-bridge']
                : []
      return { exitCode: 0, stdout: JSON.stringify(value) }
    }
    if (verb === 'plugins install') {
      mkdirSync(join(home, 'plugins', 'score_bridge'), { recursive: true })
      writeFileSync(
        join(home, 'plugins', 'score_bridge', 'plugin.yaml'),
        'name: score-bridge\nversion: 0.1.0',
      )
      writeFileSync(
        join(home, 'plugins', '.install-metadata.json'),
        JSON.stringify({ score_bridge: { revision: pin, pinned: true, source } }),
      )
    }
    if (verb === 'profile export') writeFileSync(args.at(-1)!, archive('helper'), { mode: 0o600 })
    if (verb === 'profile delete') rmSync(home, { recursive: true })
    return { exitCode: 0 }
  }
  const profiles = new ProfilesReader(upstream, runner)
  const tabs = new LiveAgentTabs(
    upstream,
    (name) => profiles.profileHome(name),
    (name) => profiles.invalidate(name),
    runner,
  )
  adapter = new LiveProfileManagement({
    scoreHome: env.home,
    hermesHome: upstream,
    db: env.db,
    profiles,
    bridgeInstallUrl: source,
    bridgeInstallRef: pin,
    runner,
    fetch: env.fake.fetch,
    port: {
      setAgentModel: (name, input) => tabs.setModel(name, input),
      readApprovals: (name) => readApprovalConfig(runner, upstream, name),
      updateApprovals: (name, edit) => updateProfileApprovals(runner, upstream, name, edit),
    },
  })
})
afterEach(async () => {
  await env.ingest.close()
  env.db.close()
  rmSync(env.home, { recursive: true, force: true })
  vi.restoreAllMocks()
})
async function step(name: ProfileStepName) {
  const result = await adapter.profileStep(name, context)
  context.targetIdentity = result.identity
}
async function provision() {
  for (const name of [
    'create_profile',
    'preserve_key',
    'configure_key',
    'model',
    'permissions',
    'install_bridge',
    'enable_bridge',
  ] as const)
    await step(name)
}
test('every create/provision command has exact argv, private key precedes config set, and readiness needs a new handshake', async () => {
  await provision()
  expect(calls[0]).toEqual([
    '-p',
    'default',
    'profile',
    'create',
    'helper',
    '--description',
    input.role,
    '--no-alias',
  ])
  expect(calls).toContainEqual(['-p', 'helper', 'config', 'set', 'API_SERVER_KEY', '[redacted]'])
  expect(calls).toContainEqual(['-p', 'helper', 'config', 'set', 'model.default', 'test-model'])
  expect(calls).toContainEqual(['-p', 'helper', 'config', 'set', 'command_allowlist', '[]'])
  expect(calls).toContainEqual([
    '-p',
    'helper',
    'config',
    'set',
    'approvals.deny',
    '["sudo *","rm *"]',
  ])
  expect(calls).toContainEqual(['-p', 'helper', 'config', 'set', 'approvals.mode', 'smart'])
  expect(calls).toContainEqual([
    '-p',
    'helper',
    'plugins',
    'install',
    source,
    '--ref',
    pin,
    '--no-enable',
  ])
  expect(calls).toContainEqual(['-p', 'helper', 'plugins', 'enable', 'score-bridge'])
  await expect(step('verify_ready')).rejects.toThrow(/No new bridge handshake/)
  env.db.sqlite
    .prepare(
      "INSERT INTO producers (id, profile, incarnation, pid, isolation, plugin_version, private_apis, token_hash, token_expires_at, created_at, last_seen_at) VALUES ('bridge', 'helper', 'new-bridge', 1, 'in_process', '0.1.0', '{}', ?, ?, ?, ?)",
    )
    .run('b'.repeat(64), Date.now() + 100000, context.createdAt, new Date().toISOString())
  await step('verify_ready')
  expect(JSON.stringify(calls)).not.toContain(
    readFileSync(join(env.home, 'hermes-keys', 'helper'), 'utf8'),
  )
})
test('clone uses only --clone-from, and an existing directory is never adopted', async () => {
  context.input = { ...input, cloneFrom: 'builder' }
  await step('create_profile')
  expect(calls[0]).toEqual([
    '-p',
    'default',
    'profile',
    'create',
    'helper',
    '--clone-from',
    'builder',
    '--description',
    input.role,
    '--no-alias',
  ])
  const before = calls.length
  await expect(step('create_profile')).rejects.toThrow(/will not adopt/)
  expect(calls).toHaveLength(before)
})
test('description pins default and uses nonempty --text with readback', async () => {
  await step('create_profile')
  await adapter.describeProfile('helper', 'Reviews tests')
  expect(calls).toContainEqual([
    '-p',
    'default',
    'profile',
    'describe',
    'helper',
    '--text',
    'Reviews tests',
  ])
  await expect(adapter.describeProfile('helper', '')).rejects.toThrow()
})
test('delete verifies private export before exact delete and purge argv', async () => {
  await step('create_profile')
  const inventory = await adapter.profileInventory('helper')
  context.exportPath = adapter.profileExportPath('helper', inventory.revision)
  await step('export')
  expect(statSync(join(env.home, 'profile-backups')).mode & 0o777).toBe(0o700)
  expect(calls.at(-1)).toEqual([
    '-p',
    'default',
    'profile',
    'export',
    'helper',
    '-o',
    context.exportPath,
  ])
  await step('delete_profile')
  await step('purge_identity')
  expect(calls.slice(-2)).toEqual([
    ['-p', 'default', 'profile', 'delete', '-y', 'helper'],
    ['-p', 'default', 'profile', 'purge-identity', 'helper'],
  ])
})
test('corrupt export and replaced profile identity stop deletion', async () => {
  await step('create_profile')
  context.exportPath = adapter.profileExportPath('helper', 'fixture')
  await step('export')
  writeFileSync(context.exportPath, 'corrupt archive')
  await expect(step('delete_profile')).rejects.toThrow()
  expect(calls.some((args) => args.includes('delete'))).toBe(false)
  context.targetIdentity = 'unrelated-identity'
  await expect(step('configure_key')).rejects.toThrow(/identity changed/)
})
test('key preservation refuses an existing key and backups refuse symlink directories', async () => {
  await step('create_profile')
  await step('preserve_key')
  await expect(step('preserve_key')).rejects.toThrow(/will not rotate/)
  symlinkSync(upstream, join(env.home, 'profile-backups'))
  context.exportPath = adapter.profileExportPath('helper', 'fixture')
  await expect(step('export')).rejects.toThrow(/owner-only directory/)
})
test('plugin refusal stops without file-copy or enable fallbacks', async () => {
  await step('create_profile')
  refuse = 'install'
  await expect(step('install_bridge')).rejects.toThrow(/refused/)
  expect(calls.some((args) => args.includes('enable'))).toBe(false)
})
test('archive verifier rejects wrong root, truncation and checksum corruption', () => {
  const path = join(env.home, 'archive.tar.gz')
  writeFileSync(path, archive('other'), { mode: 0o600 })
  expect(() => verifyProfileArchive(path, 'helper')).toThrow(/unexpected root/)
  writeFileSync(path, archive('helper').subarray(0, 30))
  expect(() => verifyProfileArchive(path, 'helper')).toThrow()
})
test('credential-bearing CLI exceptions and output never reach logs or captures', async () => {
  const logs = [vi.spyOn(console, 'error'), vi.spyOn(console, 'log'), vi.spyOn(console, 'warn')]
  const secret = 'private-test-key'
  const execute: NonNullable<CliOptions['execute']> = (_file, _args, _options, callback) =>
    callback(Object.assign(new Error(secret), { code: 2 }), secret, secret)
  const result = await runHermes(['-p', 'helper', 'config', 'set', 'API_SERVER_KEY', secret], {
    timeoutMs: 10,
    sensitiveArgIndices: [5],
    execute,
  })
  expect(result).toEqual({ exitCode: 2 })
  expect(JSON.stringify(result)).not.toContain(secret)
  for (const log of logs) expect(log).not.toHaveBeenCalled()
  await expect(
    runHermes(['-p', 'helper', 'config', 'get', '--json', 'model'], {
      timeoutMs: 10,
      sensitiveArgIndices: [5],
      captureRead: true,
      execute,
    }),
  ).rejects.toThrow(/cannot be captured/)
})
