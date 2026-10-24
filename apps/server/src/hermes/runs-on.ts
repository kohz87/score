import type { RunsOn } from '@score/contract'

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
  sshHost: string | null
  sshUser: string | null
  sshPort: number | null
}

const LOOPBACK = new Set(['localhost', '127.0.0.1', '::1', '[::1]', 'ip6-localhost'])

export function describeRunsOn(settings: TerminalSettings, thisHost: string): RunsOn {
  const raw = settings.backend
  const name = (raw ?? 'local').trim().toLowerCase()
  const base = { raw, docker: null, ssh: null, checked: CONFINEMENT_CHECKED }
  if (name === '' || name === 'local')
    return {
      ...base,
      backend: 'local',
      separated: 'no',
      separatedTools: [],
      hostTools: [],
      notes: ['Everything the agent does runs on this machine as you.'],
    }
  if (name === 'docker') {
    // Hermes's defaults (terminal_tool.py): network on, cwd not mounted, root inside the container.
    const network = settings.dockerNetwork ?? true
    const mountsWorkspace = settings.dockerMountCwd ?? false
    const runsAsRoot = !(settings.dockerRunAsHostUser ?? false)
    const extraMounts = Array.isArray(settings.dockerVolumes) ? settings.dockerVolumes.length : 0
    const notes = [
      'Credential files your skills or settings register, and your skills, are shared into the container read-only.',
    ]
    if (network) notes.push('The container can reach the internet and your local network.')
    if (mountsWorkspace)
      notes.push('The agent’s working folder on this machine is mounted into the container.')
    if (extraMounts)
      notes.push(
        `${extraMounts} more folder${extraMounts === 1 ? '' : 's'} from this machine are mounted.`,
      )
    if (runsAsRoot) notes.push('Commands run as root inside the container.')
    return {
      ...base,
      backend: 'docker',
      separated: 'partly',
      docker: { image: settings.dockerImage, network, mountsWorkspace, runsAsRoot, extraMounts },
      separatedTools: SEPARATED_TOOLS,
      hostTools: HOST_TOOLS,
      notes,
    }
  }
  if (name === 'ssh') {
    const host = settings.sshHost
    const sameMachine =
      host === null ||
      LOOPBACK.has(host.toLowerCase()) ||
      host.toLowerCase() === thisHost.toLowerCase()
    return {
      ...base,
      backend: 'ssh',
      separated: sameMachine ? 'no' : 'partly',
      ssh: { host, user: settings.sshUser, port: settings.sshPort, sameMachine },
      separatedTools: sameMachine ? [] : SEPARATED_TOOLS,
      hostTools: sameMachine ? [] : HOST_TOOLS,
      notes: sameMachine
        ? ['The SSH host is this machine, so nothing is separated.']
        : [
            'The other machine’s user and key are the boundary: what that account can reach, the agent can.',
            'Hermes copies credential files and skills to the other machine.',
          ],
    }
  }
  return {
    ...base,
    backend: 'other',
    separated: 'unknown',
    separatedTools: [],
    hostTools: [],
    notes: ['Score doesn’t know what this backend separates. Check its Hermes documentation.'],
  }
}
