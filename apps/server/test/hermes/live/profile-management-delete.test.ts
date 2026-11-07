import { rmSync, statSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'
import type { ProfileStepName } from '@score/contract'
import {
  installProfileManagementHooks,
  profileStep,
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
  await step('preserve_key')
  const key = join(env.home, 'hermes-keys', 'helper')
  expect(statSync(key).isFile()).toBe(true)
  await step('delete_profile')
  await step('purge_identity')
  // Score's copy of the deleted profile's API key goes with it.
  expect(() => statSync(key)).toThrow()
  expect(calls.slice(-2)).toEqual([
    ['-p', 'default', 'profile', 'delete', '-y', 'helper'],
    ['-p', 'default', 'profile', 'purge-identity', 'helper'],
  ])
})

test('the backup and its directory are synced before the profile is deleted', async () => {
  await step('create_profile')
  context.exportPath = adapter.profileExportPath('helper', 'fixture')
  synced.length = 0
  await step('export')
  expect(synced).toContain(context.exportPath)
  expect(synced).toContain(join(env.home, 'profile-backups'))
})

test('a delete that removed the profile but failed identity settlement still advances', async () => {
  await step('create_profile')
  context.exportPath = adapter.profileExportPath('helper', 'fixture')
  await step('export')
  partialDelete = true
  await step('delete_profile')
  partialDelete = false
  await step('purge_identity')
  expect(calls.at(-1)).toEqual(['-p', 'default', 'profile', 'purge-identity', 'helper'])
})

test('corrupt export and replaced profile identity stop deletion', async () => {
  await step('create_profile')
  context.exportPath = adapter.profileExportPath('helper', 'fixture')
  await step('export')
  writeFileSync(context.exportPath, 'corrupt archive')
  await expect(step('delete_profile')).rejects.toThrow()
  expect(calls.some((args) => args.includes('delete'))).toBe(false)
  context.targetIdentity = 'unrelated-identity'
  await expect(step('configure_key')).rejects.toThrow(/The profile changed/)
})

test('key preservation refuses an existing key and backups refuse symlink directories', async () => {
  await step('create_profile')
  await step('preserve_key')
  await expect(step('preserve_key')).rejects.toThrow(/won’t replace/)
  symlinkSync(upstream, join(env.home, 'profile-backups'))
  context.exportPath = adapter.profileExportPath('helper', 'fixture')
  await expect(step('export')).rejects.toThrow(/private to your user/)
})

test('a retried export reuses its own earlier file instead of failing, but never a symlink', async () => {
  await step('create_profile')
  context.exportPath = adapter.profileExportPath('helper', 'retry')
  await step('export')
  const exports = calls.filter((args) => args.includes('export')).length
  await step('export')
  expect(calls.filter((args) => args.includes('export'))).toHaveLength(exports)
  rmSync(context.exportPath)
  symlinkSync(join(env.home, 'elsewhere'), context.exportPath)
  await expect(step('export')).rejects.toThrow(/unsafe or already in use/)
})
