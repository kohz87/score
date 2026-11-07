import {
  WorkflowDefinitionSchema,
  type WorkflowDefinition,
} from '../packages/contract/src/index.ts'
import { agent } from './workflow-fixtures-helpers.ts'

/** A routed agent failure (the 7.1 e2e shape): the failed attempt has its own path to an end. */
export const failureRouteDefinition: WorkflowDefinition = WorkflowDefinitionSchema.parse({
  name: 'Failure route',
  inputs: [],
  nodes: [
    { ...agent('build', 'Build', 'Build the thing.'), onFailure: 'route' },
    agent('fix', 'Repair', 'Repair the failed build.'),
    { id: 'good', kind: 'end', label: 'Built' },
    { id: 'fixed', kind: 'end', label: 'Repaired' },
  ],
  edges: [
    { id: 'e1', from: 'build', port: 'ok', to: 'good' },
    { id: 'e2', from: 'build', port: 'failed', to: 'fix' },
    { id: 'e3', from: 'fix', port: 'ok', to: 'fixed' },
  ],
})

/** A gate whose rejection takes its own route instead of stopping the run. */
export const gateRejectDefinition: WorkflowDefinition = WorkflowDefinitionSchema.parse({
  name: 'Review route',
  inputs: [],
  nodes: [
    agent('build', 'Build it', 'Build the release.'),
    {
      id: 'approve',
      kind: 'gate',
      label: 'Approve it',
      question: 'Ship it?',
      onReject: 'route',
    },
    agent('repair', 'Repair it', 'Repair what review found.'),
    { id: 'accepted', kind: 'end', label: 'Accepted' },
    { id: 'rejected', kind: 'end', label: 'Rejected' },
  ],
  edges: [
    { id: 'e1', from: 'build', port: 'ok', to: 'approve' },
    { id: 'e2', from: 'approve', port: 'ok', to: 'accepted' },
    { id: 'e3', from: 'approve', port: 'rejected', to: 'repair' },
    { id: 'e4', from: 'repair', port: 'ok', to: 'rejected' },
  ],
})

/** Two branch paths that meet at a join, then one end. */
export const joinDefinition: WorkflowDefinition = WorkflowDefinitionSchema.parse({
  name: 'Wait for both',
  inputs: [],
  nodes: [
    agent('start', 'Start', 'Start both paths.'),
    {
      id: 'pick',
      kind: 'branch',
      label: 'Which way?',
      subject: 'start',
      rules: [{ id: 'rule1', when: { kind: 'verdict', is: 'passed' } }],
    },
    agent('left', 'Left', 'Do the left path.'),
    agent('right', 'Right', 'Do the right path.'),
    { id: 'both', kind: 'join', label: 'Wait for both', mode: 'all' },
    { id: 'done', kind: 'end', label: 'Done' },
  ],
  edges: [
    { id: 'e1', from: 'start', port: 'ok', to: 'pick' },
    { id: 'e2', from: 'pick', port: 'rule1', to: 'left' },
    { id: 'e3', from: 'pick', port: 'default', to: 'right' },
    { id: 'e4', from: 'left', port: 'ok', to: 'both' },
    { id: 'e5', from: 'right', port: 'ok', to: 'both' },
    { id: 'e6', from: 'both', port: 'ok', to: 'done' },
  ],
})
