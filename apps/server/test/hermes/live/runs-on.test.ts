import fs from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { LiveAgentTabs } from '../../../src/hermes/live/agent-tabs.ts'
import type { HermesRunner } from '../../../src/hermes/live/cli.ts'
import { ProfilesReader } from '../../../src/hermes/live/profiles.ts'
import { describeRunsOn, hostIs, type TerminalSettings } from '../../../src/hermes/runs-on.ts'

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
    docker_extra_args: [],
    docker_forward_env: [],
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
  terminal.ssh_host = 'old-box'
  await expect(
    tabs.setRunsOn('builder', { backend: 'ssh', host: 'build-box', user: 'agent' }),
  ).rejects.toMatchObject({ status: 409 })
  expect(terminal.backend).toBe('local')
  expect(sets().some((args) => args.includes('terminal.backend'))).toBe(false)
  // The host written before the failure is put back.
  expect(terminal.ssh_host).toBe('old-box')
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
  runner.mockClear()
  const here = await tabs.setRunsOn('builder', { backend: 'ssh', host: 'localhost', user: 'agent' })
  expect(here).toMatchObject({ separated: 'no', ssh: { sameMachine: true }, separatedTools: [] })
  // A new host never inherits the last host's key or port.
  expect(terminal.ssh_key).toBe('')
  expect(terminal.ssh_port).toBe(22)
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
    dockerExtraArgs: [],
    dockerForwardEnv: ['GITHUB_TOKEN'],
    sshHost: null,
    sshUser: null,
    sshPort: null,
  }
  const notes = describeRunsOn(settings, me, '/home/me').notes.join(' ')
  expect(notes).toMatch(/internet/u)
  expect(notes).toMatch(/working folder .* mounted/u)
  expect(notes).toMatch(/2 more folders/u)
  expect(notes).not.toMatch(/root/u)
  expect(notes).toMatch(/1 environment variable from this machine/u)
  expect(describeRunsOn({ ...settings, backend: 'ssh', sshHost: 'Box' }, me).separated).toBe('no')
})

const me = {
  names: ['box.example.lan'],
  addresses: ['127.0.0.1', '192.168.1.20', '::1', 'fe80::1'],
}
const docker = (extra: Partial<TerminalSettings>): TerminalSettings => ({
  backend: 'docker',
  dockerImage: null,
  dockerNetwork: null,
  dockerMountCwd: null,
  dockerRunAsHostUser: null,
  dockerVolumes: [],
  dockerExtraArgs: [],
  dockerForwardEnv: [],
  sshHost: null,
  sshUser: null,
  sshPort: null,
  ...extra,
})

test('SSH to this machine in any spelling separates nothing; a plain name says Score only checks the name', () => {
  for (const host of [
    '127.0.0.2',
    '0.0.0.0',
    '0:0:0:0:0:0:0:1',
    '::ffff:127.0.0.1',
    'LOCALHOST.',
    'app.localhost',
    'box',
    'box.example.lan',
    '192.168.1.20',
    'FE80::1',
  ])
    expect(hostIs(host, me), host).toBe('same')
  expect(hostIs('10.0.0.9', me)).toBe('other')
  expect(hostIs('build-box', me)).toBe('name')
  const named = describeRunsOn(docker({ backend: 'ssh', sshHost: 'build-box' }), me)
  expect(named.separated).toBe('partly')
  expect(named.notes.join(' ')).toMatch(/checks the name, not where it points/u)
  expect(describeRunsOn(docker({ backend: 'ssh', sshHost: null }), me).separated).toBe('unknown')
})

test('Docker options or mounts that hand over this machine make it "not separated"', () => {
  for (const extra of [
    { dockerExtraArgs: ['--privileged'] },
    { dockerExtraArgs: ['--network', 'host'] },
    { dockerExtraArgs: ['--net=host'] },
    { dockerExtraArgs: ['--pid=host'] },
    { dockerExtraArgs: ['--cap-add', 'SYS_ADMIN'] },
    { dockerExtraArgs: ['-v', '/var/run/docker.sock:/var/run/docker.sock'] },
    { dockerExtraArgs: ['--mount', 'type=bind,source=/,target=/host'] },
    { dockerVolumes: ['/:/host:ro'] },
    { dockerVolumes: ['/home/me:/me'] },
    // Phase-gate review (decision 121): parents of the home, its hidden folders, system paths, other containers.
    { dockerVolumes: ['/home:/h'] },
    { dockerVolumes: ['/home/me/.ssh:/keys:ro'] },
    { dockerVolumes: ['~/.hermes:/hermes'] },
    { dockerVolumes: ['/etc:/etc:ro'] },
    { dockerVolumes: ['/proc:/host-proc'] },
    { dockerExtraArgs: ['--mount', 'type=bind,src=/root,dst=/r'] },
    { dockerExtraArgs: ['--privileged=1'] },
    { dockerExtraArgs: ['--volumes-from', 'other'] },
    // Normalized before checking: these all reach the home's keys or a system folder.
    { dockerVolumes: ['/home/me/project/../.ssh:/k'] },
    { dockerVolumes: ['/home/me/..:/h'] },
    { dockerVolumes: ['/tmp/../etc:/e'] },
    { dockerVolumes: ['//etc:/e'] },
    { dockerVolumes: ['$HOME/.aws:/aws'] },
  ]) {
    const runsOn = describeRunsOn(docker(extra), me, '/home/me')
    expect(runsOn.separated, JSON.stringify(extra)).toBe('no')
    expect(runsOn.separatedTools).toEqual([])
  }
  const projects = describeRunsOn(
    docker({ dockerVolumes: ['/home/me/project:/w'] }),
    me,
    '/home/me',
  )
  expect(projects.separated).toBe('partly')
  // An app's data under /var, a project under a root home, and a named volume stay "partly".
  for (const volume of ['/var/lib/app:/data', '/var/www/site:/site', 'data:/data'])
    expect(
      describeRunsOn(docker({ dockerVolumes: [volume] }), me, '/home/me').separated,
      volume,
    ).toBe('partly')
  expect(
    describeRunsOn(docker({ dockerVolumes: ['/root/project:/w'] }), me, '/root').separated,
  ).toBe('partly')
  // An explicit --network none wins over the docker_network setting.
  expect(
    describeRunsOn(docker({ dockerExtraArgs: ['--network=none'], dockerNetwork: true }), me).docker
      ?.network,
  ).toBe(false)
  expect(describeRunsOn(docker({ dockerVolumes: '/a:/a' }), me).separated).toBe('unknown')
})
