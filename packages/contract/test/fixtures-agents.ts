import type * as Contract from '../src/index.ts'

export const style = { color: '#4A2FD9', shape: 'circle-dot' } satisfies Contract.AgentStyle
export const agent = {
  id: 'lead',
  name: 'Lead',
  role: 'Leads the team',
  style,
  status: 'working',
  activity: 'Reviewing the contract',
  model: { id: 'example-model', label: 'Example model' },
  served: true,
} satisfies Contract.AgentSummary
export const routine = {
  id: 'routine-1',
  title: 'Nightly check',
  schedule: '1d',
  description: 'Runs the test suite.',
  lastRunAt: null,
  enabled: true,
} satisfies Contract.RoutineSummary
export const agentDetail = {
  ...agent,
  tagline: 'Builds what lead plans.',
  personality: { excerpt: 'Careful builder.', source: 'SOUL.md' },
  reportsTo: null,
  worksIn: null,
  rulesFile: 'AGENTS.md',
  model: {
    id: 'example-model',
    label: 'Example model',
    via: 'Hermes configuration',
    fallback: null,
  },
  skills: [{ name: 'git', enabled: true }],
  memory: [],
  tools: [{ id: 'terminal', label: 'Terminal', kind: 'builtin', enabled: true }],
  helpersMax: null,
  routines: [routine],
  channels: [],
  permissions: [{ id: 'installs', label: 'Installs', level: 'asks', inherited: true }],
} satisfies Contract.AgentDetail

export const room = {
  id: 'room-1',
  name: '#contract',
  kind: 'room',
  leadAgentId: 'lead',
  members: ['lead', 'builder', 'reviewer', 'designer'],
  unread: 2,
  activeAgents: ['builder'],
  channels: [{ platform: 'local', label: 'Score' }],
  pinned: true,
  archived: false,
  projectId: 'project-1',
  tags: ['q4'],
  importedFrom: null,
} satisfies Contract.Room

export const roomProject = {
  id: 'project-1',
  name: 'Launch',
  color: '#4A2FD9',
} satisfies Contract.RoomProject
