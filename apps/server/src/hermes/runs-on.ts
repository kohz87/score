import type { RunsOn } from '@score/contract'
import { isIP } from 'node:net'

// What a Hermes terminal backend separates (PLAN 11.8a, D15). Read from the Hermes source (tools/file_operations.py,
// code_execution_tool.py, image_source.py, environments/docker.py, environments/ssh.py) and checked live with Docker on
// a test profile (terminal, write_file and execute_code ran in the container; the host's files weren't visible); the
// TASKLOG has the per-tool table. Only work that goes through the backend's execute() is confined; everything else
// runs in the Hermes process.
export const CONFINEMENT_CHECKED: RunsOn['checked'] = {
  how: 'live',
  hermes: '0.21.5 (e97923c)',
  at: '2026-10-24',
}

const SEPARATED_TOOLS = [
  'Terminal commands and background processes',
  'Reading, writing and searching files',
  'Running code (execute_code)',
  'Looking at image and video files',
]
const HOST_TOOLS = [
  'Browsers and computer use',
  'Web search and page reading',
  'MCP servers',
  'Memory, skills and to-dos',
  'Scheduled jobs',
  'Messages to chat platforms',
  'Image, video and voice generation',
  'Plugins, Score’s bridge included',
]

/** The `terminal.*` settings Score reads, as Hermes answers them (null = never set). */
export interface TerminalSettings {
  backend: string | null
  dockerImage: string | null
  dockerNetwork: boolean | null
  dockerMountCwd: boolean | null
  dockerRunAsHostUser: boolean | null
  dockerVolumes: unknown
  dockerExtraArgs: unknown
  dockerForwardEnv: unknown
  sshHost: string | null
  sshUser: string | null
  sshPort: number | null
}

/** What "this machine" is, for telling an SSH host apart from it: its names and interface addresses. */
export interface ThisMachine {
  names: string[]
  addresses: string[]
}

// Canonical form of an IP literal (brackets, case and IPv6 spelling normalised), or null for a name.
function canonicalIp(host: string): string | null {
  const bare = host.replace(/^\[|\]$/gu, '')
  if (isIP(bare) === 4) return bare
  if (isIP(bare) === 6) return new URL(`http://[${bare}]/`).hostname.replace(/^\[|\]$/gu, '')
  return null
}
function isLoopbackIp(ip: string): boolean {
  return (
    /^127\./u.test(ip) ||
    ip === '0.0.0.0' ||
    ip === '::' ||
    ip === '::1' ||
    /^::ffff:(127\.|0\.0\.0\.0$|7f)/u.test(ip)
  )
}
/** 'same' for this machine in any spelling Score can see; 'name' when only DNS or an SSH alias could tell. */
export function hostIs(host: string, self: ThisMachine): 'same' | 'other' | 'name' {
  const h = host.trim().toLowerCase().replace(/\.$/u, '')
  const ip = canonicalIp(h)
  if (ip !== null) {
    const own = self.addresses.map((address) => canonicalIp(address.toLowerCase()) ?? address)
    return isLoopbackIp(ip) || own.includes(ip) ? 'same' : 'other'
  }
  const short = h.split('.')[0]!
  const names = self.names.map((name) => name.toLowerCase())
  if (
    h === 'localhost' ||
    h.endsWith('.localhost') ||
    h === 'localhost.localdomain' ||
    h === 'ip6-localhost'
  )
    return 'same'
  if (names.includes(h) || names.some((name) => name.split('.')[0] === short)) return 'same'
  return 'name'
}

// Docker options that hand the container this machine (any one makes it "not separated").
const HOST_OPTIONS = [
  /^--privileged(=true)?$/u,
  /^--(network|net)(=|$)host$/u,
  /^--(pid|ipc|uts|userns)=host$/u,
  /^--cap-add/u,
  /^--device/u,
  /^--security-opt/u,
]
function dockerArgsGiveHost(args: string[], home: string): boolean {
  return args.some((arg, i) => {
    if (HOST_OPTIONS.some((pattern) => pattern.test(arg))) return true
    if (/^--(network|net|pid|ipc|uts|userns)$/u.test(arg) && args[i + 1] === 'host') return true
    const volume =
      /^(?:-v|--volume)=(.+)$/u.exec(arg)?.[1] ??
      (/^(-v|--volume)$/u.test(arg) ? args[i + 1] : undefined)
    if (volume !== undefined && mountGivesHost(volume, home)) return true
    const mount = /^--mount=(.+)$/u.exec(arg)?.[1] ?? (arg === '--mount' ? args[i + 1] : undefined)
    const source = mount && /(?:^|,)(?:source|src)=([^,]+)/u.exec(mount)?.[1]
    return Boolean(source && mountGivesHost(source, home))
  })
}
function networkFromArgs(args: string[]): boolean | null {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    const value =
      /^--(?:network|net)=(.+)$/u.exec(arg)?.[1] ??
      (/^--(network|net)$/u.test(arg) ? args[i + 1] : undefined)
    if (value !== undefined) return value !== 'none'
  }
  return null
}
// A mount that gives the container this machine's root, Docker itself, or the person's home.
function mountGivesHost(volume: string, home: string): boolean {
  const source = volume.split(':')[0] ?? ''
  const clean = source.replace(/\/+$/u, '') || '/'
  return (
    clean === '/' ||
    clean.endsWith('docker.sock') ||
    clean === '/var/run' ||
    clean === '/run' ||
    clean === home.replace(/\/+$/u, '') ||
    clean === '~'
  )
}

const strings = (value: unknown): string[] | null =>
  value === null || value === undefined || value === ''
    ? []
    : Array.isArray(value) && value.every((item) => typeof item === 'string')
      ? value
      : null

export function describeRunsOn(settings: TerminalSettings, self: ThisMachine, home = ''): RunsOn {
  const raw = settings.backend
  const name = (raw ?? 'local').trim().toLowerCase()
  const base = { raw, docker: null, ssh: null, checked: CONFINEMENT_CHECKED }
  const unknown = (note: string, extra: Partial<RunsOn> = {}): RunsOn => ({
    ...base,
    backend: 'other',
    separated: 'unknown',
    separatedTools: [],
    hostTools: [],
    notes: [note],
    ...extra,
  })
  if (name === '' || name === 'local')
    return {
      ...base,
      backend: 'local',
      separated: 'no',
      separatedTools: [],
      hostTools: [],
      notes: [
        'Everything the agent does runs on this machine as you.',
        // Hermes also takes the backend from TERMINAL_ENV in the profile's environment, which Score never reads.
        'This is the backend in the profile’s settings; one set through its environment file isn’t visible to Score.',
      ],
    }
  if (name === 'docker') {
    // Hermes's defaults (terminal_tool.py): network on, cwd not mounted, root inside the container.
    const volumes = strings(settings.dockerVolumes)
    const extraArgs = strings(settings.dockerExtraArgs)
    const forwardEnv = strings(settings.dockerForwardEnv)
    const mountsWorkspace = settings.dockerMountCwd ?? false
    const runsAsRoot = !(settings.dockerRunAsHostUser ?? false)
    const network = (extraArgs && networkFromArgs(extraArgs)) ?? settings.dockerNetwork ?? true
    const docker = {
      image: settings.dockerImage,
      network,
      mountsWorkspace,
      runsAsRoot,
      extraMounts: volumes?.length ?? 0,
    }
    if (volumes === null || extraArgs === null || forwardEnv === null)
      return unknown('Some Docker settings of this agent aren’t in a form Score understands.', {
        backend: 'docker',
        docker,
      })
    const givesHost =
      dockerArgsGiveHost(extraArgs, home) || volumes.some((volume) => mountGivesHost(volume, home))
    const notes = [
      'Credential files your skills or settings register, and your skills, are shared into the container read-only.',
    ]
    if (givesHost)
      notes.unshift(
        'Its Docker settings give the container this machine (a privileged or host option, or a mount of / , Docker or your home folder), so nothing is separated.',
      )
    if (network) notes.push('The container can reach the internet and your local network.')
    if (mountsWorkspace)
      notes.push('The agent’s working folder on this machine is mounted into the container.')
    if (volumes.length)
      notes.push(
        `${volumes.length} more folder${volumes.length === 1 ? '' : 's'} from this machine are mounted.`,
      )
    if (extraArgs.length && !givesHost) notes.push('Extra Docker options are set for this agent.')
    if (forwardEnv.length)
      notes.push(
        `${forwardEnv.length} environment variable${forwardEnv.length === 1 ? '' : 's'} from this machine are passed in.`,
      )
    if (runsAsRoot) notes.push('Commands run as root inside the container.')
    return {
      ...base,
      backend: 'docker',
      separated: givesHost ? 'no' : 'partly',
      docker,
      separatedTools: givesHost ? [] : SEPARATED_TOOLS,
      hostTools: givesHost ? [] : HOST_TOOLS,
      notes,
    }
  }
  if (name === 'ssh') {
    const host = settings.sshHost
    if (host === null)
      return unknown('No SSH host is set, so the agent can’t start a terminal.', {
        backend: 'ssh',
        ssh: { host, user: settings.sshUser, port: settings.sshPort, sameMachine: false },
      })
    const where = hostIs(host, self)
    const sameMachine = where === 'same'
    const notes = sameMachine
      ? ['The SSH host is this machine, so nothing is separated.']
      : [
          'The other machine’s user and key are the boundary: what that account can reach, the agent can.',
          'Hermes copies credential files and skills to the other machine.',
        ]
    if (where === 'name')
      notes.push(
        `Score checks the name, not where it points: if ${host} is this machine (an alias or a local address), nothing is separated.`,
      )
    return {
      ...base,
      backend: 'ssh',
      separated: sameMachine ? 'no' : 'partly',
      ssh: { host, user: settings.sshUser, port: settings.sshPort, sameMachine },
      separatedTools: sameMachine ? [] : SEPARATED_TOOLS,
      hostTools: sameMachine ? [] : HOST_TOOLS,
      notes,
    }
  }
  return unknown('Score doesn’t know what this backend separates. Check its Hermes documentation.')
}
