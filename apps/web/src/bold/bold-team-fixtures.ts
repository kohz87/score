import { AgentDetailSchema, type AgentDetail, type CodingAgent } from '@score/contract'

export const builder = AgentDetailSchema.parse({
  id: 'builder',
  name: 'builder',
  role: 'Builds features',
  style: { color: '#19C39A', shape: 'triangle' },
  status: 'working',
  activity: 'Adding feed pagination',
  model: { id: 'demo/next-model', label: 'Next model', via: 'Demo', fallback: 'demo/safe' },
  served: true,
  tagline: 'Builds features',
  personality: { excerpt: 'I build small changes.', source: 'SOUL.md' },
  reportsTo: 'lead',
  worksIn: '/srv/app',
  rulesFile: 'AGENTS.md',
  skills: [{ name: 'collaboration', enabled: true }],
  memory: [],
  tools: [{ id: 'terminal', label: 'Terminal & Processes', kind: 'builtin', enabled: true }],
  helpersMax: 3,
  routines: [],
  channels: [],
  permissions: [
    { id: 'install packages', label: 'Installing packages', level: 'asks', inherited: false },
    { id: 'push code', label: 'Pushing code', level: 'asks', inherited: false },
    { id: 'delete files', label: 'Deleting files', level: 'asks', inherited: false },
    {
      id: 'use the screen',
      label: 'Using the mouse and keyboard on its screen',
      level: 'asks',
      inherited: false,
    },
    { id: 'SQL DROP', label: 'SQL DROP', level: 'allowed', inherited: true },
  ],
})

export const coderDetail = AgentDetailSchema.parse({
  ...builder,
  id: 'coder',
  name: 'coder',
  role: 'Reviews build scripts',
  style: { color: '#6B4EFF', shape: 'hexagon' },
  status: 'idle',
  activity: null,
  model: null,
  runtime: 'codex',
  runtimeNote: 'Codex · uses your ChatGPT plan quota',
  tagline: '',
  personality: { excerpt: '', source: 'SOUL.md' },
  reportsTo: null,
  worksIn: null,
  rulesFile: null,
  skills: [],
  memory: [],
  tools: [],
  routines: [],
  channels: [],
  permissions: [],
  helpersMax: null,
})

export const coder: CodingAgent = {
  id: 'coder',
  name: 'coder',
  role: 'Reviews build scripts',
  instructions: '',
  instructionsEtag: 'etag-1',
  runtime: 'codex',
  workspace: '/home/user/score-workspaces/coder',
  permission: 'workspace-write',
  model: null,
  effort: null,
  advisorModel: null,
  style: { color: '#6B4EFF', shape: 'hexagon' },
  quota: 'Uses your ChatGPT plan quota.',
  quotaFloorPercent: 10,
  cli: { state: 'ready', version: '0.160.1', testedVersions: ['0.160.1'], problem: null },
  heldGroups: [],
  createdAt: '2026-10-16T00:00:00.000Z',
}

export const localRunsOn = {
  backend: 'local',
  raw: 'local',
  separated: 'no',
  docker: null,
  ssh: null,
  separatedTools: [],
  hostTools: [],
  notes: ['Everything the agent does runs on this machine as you.'],
  checked: { how: 'live', hermes: '0.21.5 (e97923c)', at: '2026-10-24' },
}
export const dockerRunsOn = {
  backend: 'docker',
  raw: 'docker',
  separated: 'partly',
  docker: {
    image: 'sandbox:1',
    network: false,
    mountsWorkspace: false,
    runsAsRoot: true,
    extraMounts: 0,
  },
  ssh: null,
  separatedTools: ['Terminal commands and background processes'],
  hostTools: ['MCP servers'],
  notes: ['Commands run as root inside the container.'],
  checked: { how: 'live', hermes: '0.21.5 (e97923c)', at: '2026-10-24' },
}

export const codingRuntimes = [
  {
    runtime: 'claude-code',
    label: 'Claude Code',
    state: 'ready',
    version: '2.1.295',
    testedVersions: ['2.1.295'],
    quota: 'Uses your Claude plan quota.',
    message: null,
    unverifiedPermissions: [],
    warning: null,
  },
  {
    runtime: 'codex',
    label: 'Codex',
    state: 'ready',
    version: '0.160.1',
    testedVersions: ['0.160.1'],
    quota: 'Uses your ChatGPT plan quota.',
    message: null,
    unverifiedPermissions: [],
    warning: null,
  },
  {
    runtime: 'antigravity',
    label: 'Antigravity (agy)',
    state: 'not_installed',
    version: null,
    testedVersions: ['1.3.3'],
    quota: 'Uses your Google plan quota.',
    message: 'Antigravity (agy) is not installed or not on PATH.',
    unverifiedPermissions: ['full'],
    warning: null,
  },
] as const

export function now() {
  return {
    asOfSeq: 1,
    now: '2026-10-24T10:00:00.000Z',
    paused: false,
    headline: { working: 1, needsYou: 0, text: 'One agent is working.' },
    lanes: [],
    handoffs: [],
    focusApproval: null,
    thread: null,
    madeToday: [],
  }
}

export function agentResponse(agent: AgentDetail): Response {
  return Response.json(agent)
}

export function completedOperation(): Response {
  return Response.json({
    id: '11111111-1111-4111-8111-111111111111',
    kind: 'create',
    targetName: 'runs-agent',
    incarnationId: '22222222-2222-4222-8222-222222222222',
    requestHash: 'a'.repeat(64),
    state: 'completed',
    steps: [],
    createdAt: '2026-10-24T10:00:00.000Z',
    updatedAt: '2026-10-24T10:00:01.000Z',
    nextStep: null,
    error: null,
    exportPath: null,
  })
}

export function emptyFor(pathname: string): Response {
  if (pathname.endsWith('/memory')) return Response.json({ items: [], nextCursor: null })
  if (pathname.endsWith('/skills')) return Response.json({ items: [] })
  if (pathname.endsWith('/todos'))
    return Response.json({ todos: [], revision: 1, updatedAt: '2026-10-24T10:00:00.000Z' })
  if (pathname.endsWith('/routines') || pathname.endsWith('/channels'))
    return Response.json({ items: [] })
  if (pathname.endsWith('/history')) return Response.json({ items: [], nextCursor: null })
  if (pathname.endsWith('/quota')) return Response.json({ quota: null })
  if (pathname.endsWith('/coding-agents')) return Response.json({ items: [] })
  return Response.json({ items: [], nextCursor: null })
}
