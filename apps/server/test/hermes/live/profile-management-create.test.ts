import { chmodSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'
import type { ProfileStepName } from '@score/contract'
import {
  archive,
  input,
  installProfileManagementHooks,
  pin,
  profileStep,
  provisionProfile,
  source,
  type ProfileManagementState,
} from './profile-management-helpers.ts'

const synced: string[] = []
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs')>()
  return {
    ...actual,
    fsyncSync(fd: number) {
      synced.push(actual.readlinkSync(`/proc/self/fd/${fd}`))
      return actual.fsyncSync(fd)
    },
  }
})

let partialDelete: ProfileManagementState['partialDelete'] = false
let env: ProfileManagementState['env']
let upstream: ProfileManagementState['upstream']
let adapter: ProfileManagementState['adapter']
let calls: ProfileManagementState['calls']
let context: ProfileManagementState['context']
let deny: ProfileManagementState['deny']
let refuse: ProfileManagementState['refuse']
const testState: ProfileManagementState = {
  get partialDelete() {
    return partialDelete
  },
  set partialDelete(value) {
    partialDelete = value
  },
  get env() {
    return env
  },
  set env(value) {
    env = value
  },
  get upstream() {
    return upstream
  },
  set upstream(value) {
    upstream = value
  },
  get adapter() {
    return adapter
  },
  set adapter(value) {
    adapter = value
  },
  get calls() {
    return calls
  },
  set calls(value) {
    calls = value
  },
  get context() {
    return context
  },
  set context(value) {
    context = value
  },
  get deny() {
    return deny
  },
  set deny(value) {
    deny = value
  },
  get refuse() {
    return refuse
  },
  set refuse(value) {
    refuse = value
  },
}
installProfileManagementHooks(testState)
const step = (name: ProfileStepName) => profileStep(testState, name)
const provision = () => provisionProfile(testState)

test('every create/provision command has exact argv, private key precedes config set, and readiness does not wait for a first-run handshake', async () => {
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
  // 2.1.0: Score's agents keep every tool visible (Hermes 0.22.5's Tool Search off).
  expect(calls).toContainEqual([
    '-p',
    'helper',
    'config',
    'set',
    'tools.tool_search.enabled',
    'off',
  ])
  // Ready without a handshake: the bridge connects on the profile's first run.
  await expect(step('verify_ready')).resolves.not.toThrow()
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
  await expect(step('create_profile')).rejects.toThrow(/take it over/)
  expect(calls).toHaveLength(before)
})

test("import hands Hermes only Score's private upload with argv, never adopts, and reinstalls the pinned bridge", async () => {
  const dir = join(env.home, 'profile-imports')
  mkdirSync(dir, { mode: 0o700 })
  const file = join(dir, '20000000-0000-4000-8000-000000000002.tar.gz')
  writeFileSync(file, archive('helper'), { mode: 0o600 })
  // Outside the upload directory, or readable by others: refused before any process runs.
  context.importArchive = join(env.home, 'elsewhere.tar.gz')
  await expect(step('import_profile')).rejects.toThrow(/isn’t in Score’s storage/)
  context.importArchive = file
  chmodSync(file, 0o644)
  await expect(step('import_profile')).rejects.toThrow(/private file/)
  chmodSync(file, 0o600)
  expect(calls).toEqual([])
  await step('import_profile')
  expect(calls).toEqual([['-p', 'default', 'profile', 'import', file, '--name', 'helper']])
  await expect(step('import_profile')).rejects.toThrow(/take it over/)
  await step('install_bridge')
  expect(calls.at(-1)).toEqual([
    '-p',
    'helper',
    'plugins',
    'install',
    source,
    '--ref',
    pin,
    '--no-enable',
    '--force',
  ])
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

test('plugin refusal stops without file-copy or enable fallbacks', async () => {
  await step('create_profile')
  refuse = 'install'
  await expect(step('install_bridge')).rejects.toThrow(/refused/)
  expect(calls.some((args) => args.includes('enable'))).toBe(false)
})

test('a rebaseline removes the Never rules Score applied before, and keeps Hermes-owned ones', async () => {
  await provision()
  deny = ['git push*', 'hermes-own *']
  context.baseline = { ...context.baseline, never: [] }
  context.previousNever = ['git push*']
  await step('permissions')
  expect(deny).toEqual(['hermes-own *'])
})
