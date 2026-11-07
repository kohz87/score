import { mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { gzipSync } from 'node:zlib'
import { afterEach, beforeEach, expect, vi } from 'vitest'
import type { AgentCreateInput, ProfileStepName } from '@score/contract'
import { LiveAgentTabs } from '../../../src/hermes/live/agent-tabs.ts'
import { readApprovalConfig, updateProfileApprovals } from '../../../src/hermes/live/approvals.ts'
import type { HermesRunner } from '../../../src/hermes/live/cli.ts'
import { LiveProfileManagement } from '../../../src/hermes/live/profile-management.ts'
import { ProfilesReader } from '../../../src/hermes/live/profiles.ts'
import type { ProfileStepContext } from '../../../src/hermes/profile-management.ts'
import { setup } from './gateway/helpers.ts'

export const pin = 'a'.repeat(40)
export const source = 'https://example.invalid/score.git#hermes-plugin/score_bridge'
export const input: AgentCreateInput = {
  id: 'helper',
  name: 'Helper',
  role: 'Builds small changes',
  model: 'test-model',
  style: { color: '#19C39A', shape: 'triangle' },
}

export function archive(name: string) {
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

// GNU tar, as Hermes writes it: a ././@LongLink ("L") record carries a name over 100 bytes for the next entry.
export function gnuArchive(longName: string) {
  const block = (name: string, type: string, size: number) => {
    const header = Buffer.alloc(512)
    header.write(name.slice(0, 99), 0)
    header.write('0000644\0', 100)
    header.write('0000000\0', 108)
    header.write('0000000\0', 116)
    header.write(`${size.toString(8).padStart(11, '0')}\0`, 124)
    header.write('00000000000\0', 136)
    header.fill(32, 148, 156)
    header.write(type, 156)
    header.write('ustar  \0', 257)
    const checksum = header.reduce((sum, byte) => sum + byte, 0)
    header.write(`${checksum.toString(8).padStart(6, '0')}\0 `, 148)
    return header
  }
  const name = Buffer.from(`${longName}\0`)
  const data = Buffer.concat([name, Buffer.alloc(Math.ceil(name.length / 512) * 512 - name.length)])
  return gzipSync(
    Buffer.concat([
      block('././@LongLink', 'L', name.length),
      data,
      block(longName, '0', 0),
      Buffer.alloc(1024),
    ]),
  )
}

export type ProfileManagementState = {
  partialDelete: boolean
  env: ReturnType<typeof setup>
  upstream: string
  adapter: LiveProfileManagement
  calls: string[][]
  context: ProfileStepContext
  deny: string[]
  refuse: string | null
}

export function installProfileManagementHooks(state: ProfileManagementState) {
  let model: string
  let allowlist: string[]
  let mode: string

  beforeEach(() => {
    state.env = setup()
    state.upstream = join(state.env.home, 'upstream')
    mkdirSync(join(state.upstream, 'profiles'), { recursive: true })
    state.calls = []
    model = 'initial'
    allowlist = ['recursive delete']
    state.deny = ['rm *']
    mode = 'off'
    state.refuse = null
    state.context = {
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
      state.calls.push(args.map((arg, index) => (secret && index === 5 ? '[redacted]' : arg)))
      if (args.includes(state.refuse ?? '<nothing>')) return { exitCode: 2 }
      const name = args[1]!
      const verb = args.slice(2, 4).join(' ')
      const home = join(state.upstream, 'profiles', 'helper')
      if (verb === 'profile create') {
        mkdirSync(home)
        writeFileSync(join(home, 'config.yaml'), 'model: initial')
        writeFileSync(
          join(home, 'profile.yaml'),
          `description: ${args[args.indexOf('--description') + 1]}`,
        )
      }
      if (verb === 'profile import') mkdirSync(home)
      if (verb === 'profile describe')
        writeFileSync(join(home, 'profile.yaml'), `description: ${args.at(-1)}`)
      if (verb === 'config set') {
        const key = args[4]
        const value = args[5]!
        if (key === 'API_SERVER_KEY') {
          expect(options.sensitiveArgIndices).toEqual([5])
          // The private key was durable before it was sent to the CLI.
          expect(readFileSync(join(state.env.home, 'hermes-keys', name), 'utf8')).toBe(value)
          expect(statSync(join(state.env.home, 'hermes-keys', name)).mode & 0o777).toBe(0o600)
          state.env.fake.keys.set(name, value)
        }
        if (key === 'model.default') model = value
        if (key === 'command_allowlist') allowlist = JSON.parse(value)
        if (key === 'approvals.deny') state.deny = JSON.parse(value)
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
                ? { mode, deny: state.deny }
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
      if (verb === 'profile delete') {
        rmSync(home, { recursive: true })
        if (state.partialDelete) return { exitCode: 1 }
      }
      return { exitCode: 0 }
    }
    const profiles = new ProfilesReader(state.upstream, runner)
    const tabs = new LiveAgentTabs(
      state.upstream,
      (name) => profiles.profileHome(name),
      (name) => profiles.invalidate(name),
      runner,
    )
    state.adapter = new LiveProfileManagement({
      scoreHome: state.env.home,
      hermesHome: state.upstream,
      db: state.env.db,
      profiles,
      bridgeInstallUrl: source,
      bridgeInstallRef: pin,
      runner,
      fetch: state.env.fake.fetch,
      port: {
        setAgentModel: (name, input) => tabs.setModel(name, input),
        readApprovals: (name) => readApprovalConfig(runner, state.upstream, name),
        updateApprovals: (name, edit) => updateProfileApprovals(runner, state.upstream, name, edit),
      },
    })
  })
  afterEach(async () => {
    await state.env.ingest.close()
    state.env.db.close()
    rmSync(state.env.home, { recursive: true, force: true })
    vi.restoreAllMocks()
  })
}

export async function profileStep(state: ProfileManagementState, name: ProfileStepName) {
  const result = await state.adapter.profileStep(name, state.context)
  state.context.targetIdentity = result.identity
}

export async function provisionProfile(state: ProfileManagementState) {
  for (const name of [
    'create_profile',
    'preserve_key',
    'configure_key',
    'model',
    'permissions',
    'install_bridge',
    'enable_bridge',
  ] as const)
    await profileStep(state, name)
}
