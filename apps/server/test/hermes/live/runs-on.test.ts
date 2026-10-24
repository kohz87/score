import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { LiveAgentTabs } from '../../../src/hermes/live/agent-tabs.ts'
import type { HermesRunner } from '../../../src/hermes/live/cli.ts'
import { ProfilesReader } from '../../../src/hermes/live/profiles.ts'
import { describeRunsOn, type TerminalSettings } from '../../../src/hermes/runs-on.ts'

const fixture = fileURLToPath(new URL('../../fixtures/hermes/', import.meta.url))
let home: string
let terminal: Record<string, unknown>
let failSet: string | null
const runner = vi.fn<HermesRunner>()
// Stands in for `hermes`: `config get --json terminal.<key>` answers from `terminal`, `config set` writes into it.
function hermes(args: string[]): { exitCode: number; stdout?: string } {
  const rest = args[0] === '-p' ? args.slice(2) : args
  if (
    rest[0] === 'config' &&
    rest[1] === 'get' &&
    rest[2] === '--json' &&
    rest[3]?.startsWith('terminal.')
  ) {
    const key = rest[3].slice('terminal.'.length)
    return key in terminal
      ? { exitCode: 0, stdout: JSON.stringify(terminal[key]) }
      : { exitCode: 1 }
  }
  if (rest[0] === 'config' && rest[1] === 'set' && rest[2]?.startsWith('terminal.')) {
    if (rest[2] === failSet) return { exitCode: 2 }
    const value = rest[3]!
    terminal[rest[2].slice('terminal.'.length)] =
      value === 'true'
        ? true
        : value === 'false'
          ? false
          : /^\d+$/u.test(value)
            ? Number(value)
            : value
    return { exitCode: 0 }
  }
  return { exitCode: 0, stdout: '' }
}
let tabs: LiveAgentTabs
beforeEach(() => {
  home = fs.mkdtempSync(join(tmpdir(), 'score-runs-on-'))
  fs.cpSync(join(fixture, 'profiles', 'default'), home, { recursive: true })
  fs.cpSync(join(fixture, 'profiles', 'builder'), join(home, 'profiles', 'builder'), {
    recursive: true,
  })
  // Hermes answers every terminal key with its default filled in (verified live, 2026-10-24).
  terminal = {
    backend: 'local',
    docker_image: 'nousresearch/hermes-sandbox:desktop',
    docker_network: true,
    docker_mount_cwd_to_workspace: false,
    docker_run_as_host_user: false,
    docker_volumes: [],
  }
  failSet = null
  runner.mockReset().mockImplementation(async (args) => hermes(args))
  const reader = new ProfilesReader(home, runner)
  tabs = new LiveAgentTabs(
    home,
    (profile) => reader.profileHome(profile),
    (profile) => reader.invalidate(profile),
    runner,
  )
  tabs.dockerReady = async () => true
})
afterEach(() => fs.rmSync(home, { recursive: true, force: true }))
const sets = () => runner.mock.calls.map(([args]) => args).filter((args) => args.includes('set'))

test('a local agent is "this machine as you", not separated', async () => {
  const runsOn = await tabs.readRunsOn('builder')
  expect(runsOn).toMatchObject({ backend: 'local', raw: 'local', separated: 'no', docker: null })
  expect(runsOn.checked.how).toBe('live')
})

test('Docker is set through the CLI, settings before the backend, and says exactly what it separates', async () => {
  const runsOn = await tabs.setRunsOn('builder', { backend: 'docker', network: false })
  expect(sets()).toEqual([
    ['-p', 'builder', 'config', 'set', 'terminal.docker_network', 'false'],
    ['-p', 'builder', 'config', 'set', 'terminal.backend', 'docker'],
  ])
  expect(runsOn.separated).toBe('partly')
  expect(runsOn.docker).toEqual({
    image: 'nousresearch/hermes-sandbox:desktop',
    network: false,
    mountsWorkspace: false,
    runsAsRoot: true,
    extraMounts: 0,
  })
  expect(runsOn.separatedTools).toContain('Reading, writing and searching files')
  expect(runsOn.hostTools).toEqual(
    expect.arrayContaining(['MCP servers', 'Browsers and computer use']),
  )
  expect(runsOn.notes.join(' ')).toMatch(/Credential files .* read-only/u)
  expect(runsOn.notes.join(' ')).not.toMatch(/internet/u)
})

test('without Docker nothing is written', async () => {
  tabs.dockerReady = async () => false
  await expect(tabs.setRunsOn('builder', { backend: 'docker' })).rejects.toMatchObject({
    status: 409,
    code: 'backend_unavailable',
  })
  expect(sets()).toEqual([])
})

test('a failed setting leaves the backend where it was', async () => {
  failSet = 'terminal.ssh_user'
  await expect(
    tabs.setRunsOn('builder', { backend: 'ssh', host: 'build-box', user: 'agent' }),
  ).rejects.toMatchObject({ status: 409 })
  expect(terminal.backend).toBe('local')
  expect(sets().some((args) => args.includes('terminal.backend'))).toBe(false)
})

test('SSH stores the key path only, and SSH to this machine separates nothing', async () => {
  const away = await tabs.setRunsOn('builder', {
    backend: 'ssh',
    host: 'build-box',
    user: 'agent',
    port: 2222,
    keyPath: '/home/me/.ssh/agent_key',
  })
  expect(sets().map((args) => args[4])).toEqual([
    'terminal.ssh_host',
    'terminal.ssh_user',
    'terminal.ssh_port',
    'terminal.ssh_key',
    'terminal.backend',
  ])
  expect(away).toMatchObject({
    separated: 'partly',
    ssh: { host: 'build-box', user: 'agent', port: 2222 },
  })
  const here = await tabs.setRunsOn('builder', { backend: 'ssh', host: 'localhost', user: 'agent' })
  expect(here).toMatchObject({ separated: 'no', ssh: { sameMachine: true }, separatedTools: [] })
})

test('an unknown backend is "unknown", and Hermes not answering is 502', async () => {
  terminal.backend = 'modal'
  expect(await tabs.readRunsOn('builder')).toMatchObject({
    backend: 'other',
    separated: 'unknown',
    raw: 'modal',
  })
  runner.mockImplementation(async () => ({ exitCode: -1 }))
  await expect(tabs.readRunsOn('builder')).rejects.toMatchObject({ status: 502 })
})

test('Docker caveats follow the settings', () => {
  const settings: TerminalSettings = {
    backend: 'docker',
    dockerImage: null,
    dockerNetwork: null,
    dockerMountCwd: true,
    dockerRunAsHostUser: true,
    dockerVolumes: ['/a:/a', '/b:/b'],
    sshHost: null,
    sshUser: null,
    sshPort: null,
  }
  const notes = describeRunsOn(settings, 'box').notes.join(' ')
  expect(notes).toMatch(/internet/u)
  expect(notes).toMatch(/working folder .* mounted/u)
  expect(notes).toMatch(/2 more folders/u)
  expect(notes).not.toMatch(/root/u)
  expect(describeRunsOn({ ...settings, backend: 'ssh', sshHost: 'Box' }, 'box').separated).toBe(
    'no',
  )
})
