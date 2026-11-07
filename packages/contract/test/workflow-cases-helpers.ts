import type * as contract from '../src/index.ts'

export type WorkflowCase = readonly [keyof typeof contract, unknown, unknown]

export const agentNode = {
  id: 'draft',
  kind: 'agent',
  label: 'Draft',
  agentId: 'builder',
  instruction: 'Write about {{inputs.topic}}',
  retries: 1,
  onFailure: 'fail_run',
} as const
export const gateNode = {
  id: 'approve',
  kind: 'gate',
  label: 'Approve',
  question: 'Ship it?',
  onReject: 'stop_run',
} as const
export const branchNode = {
  id: 'route',
  kind: 'branch',
  label: 'Route',
  subject: 'draft',
  rules: [{ id: 'good', when: { kind: 'verdict', is: 'passed' } }],
} as const
export const joinNode = { id: 'merge', kind: 'join', label: 'Merge', mode: 'all' } as const
export const endNode = { id: 'done', kind: 'end', label: 'Done' } as const
export const edge = { id: 'e1', from: 'draft', port: 'ok', to: 'approve' } as const
export const input = { name: 'topic', label: 'Topic', required: true, maxChars: 200 } as const
export const workflowDefinition = {
  name: 'Release notes',
  inputs: [input],
  nodes: [agentNode, gateNode, endNode],
  edges: [edge, { id: 'e2', from: 'approve', port: 'ok', to: 'done' }],
} as const
