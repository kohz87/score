import { writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { expect, test, vi } from 'vitest'
import { runHermes, type CliOptions } from '../../../src/hermes/live/cli.ts'
import { verifyProfileArchive } from '../../../src/hermes/live/profile-management.ts'
import {
  archive,
  gnuArchive,
  installProfileManagementHooks,
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

test('archive verifier rejects wrong root, truncation and checksum corruption', () => {
  const path = join(env.home, 'archive.tar.gz')
  writeFileSync(path, archive('other'), { mode: 0o600 })
  expect(() => verifyProfileArchive(path, 'helper')).toThrow(/unexpected layout/)
  writeFileSync(path, archive('helper').subarray(0, 30))
  expect(() => verifyProfileArchive(path, 'helper')).toThrow()
})

test('archive verifier reads GNU long names (as Hermes exports them) and still checks their root', () => {
  const path = join(env.home, 'archive.tar.gz')
  const deep = `helper/skills/${'nested-directory/'.repeat(8)}SKILL.md`
  writeFileSync(path, gnuArchive(deep), { mode: 0o600 })
  expect(() => verifyProfileArchive(path, 'helper')).not.toThrow()
  writeFileSync(path, gnuArchive(`other/${'nested-directory/'.repeat(8)}x`), { mode: 0o600 })
  expect(() => verifyProfileArchive(path, 'helper')).toThrow(/unexpected layout/)
  writeFileSync(path, gnuArchive(`helper/${'../'.repeat(40)}etc/passwd`), { mode: 0o600 })
  expect(() => verifyProfileArchive(path, 'helper')).toThrow(/unexpected layout/)
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
