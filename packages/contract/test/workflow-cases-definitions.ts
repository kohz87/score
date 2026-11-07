import { at } from './fixtures-common.ts'
import {
  agentNode,
  branchNode,
  edge,
  endNode,
  gateNode,
  input,
  joinNode,
  workflowDefinition,
} from './workflow-cases-helpers.ts'
import type { WorkflowCase } from './workflow-cases-helpers.ts'

// Valid and invalid fixtures for contract §15 (schemas-coverage.test.ts requires a pair for every exported schema).

const validation = {
  ok: false,
  issues: [
    {
      code: 'unrouted_failure',
      severity: 'error',
      nodeId: 'draft',
      edgeId: null,
      field: null,
      message: 'Draft has no failed edge',
    },
  ],
  stats: { nodes: 3, edges: 2, maxSteps: 2, bytes: 400 },
} as const
const versionSummary = {
  version: 2,
  hash: 'a'.repeat(64),
  createdAt: at,
  used: false,
  bytes: 400,
  nodes: 3,
  maxSteps: 2,
} as const
const workflowSummary = {
  id: 'wf-1',
  name: 'Release notes',
  description: null,
  latestVersion: 2,
  versionCount: 2,
  used: true,
  agentIds: ['builder'],
  createdAt: at,
  updatedAt: at,
  activeRuns: 0,
  archivedAt: null,
} as const
const version = { ...versionSummary, workflowId: 'wf-1', definition: workflowDefinition } as const
const portable = {
  name: 'Release notes',
  inputs: [input],
  nodes: [
    {
      id: 'draft',
      kind: 'agent',
      label: 'Draft',
      agent: { name: 'Builder', role: null },
      instruction: 'Write',
      retries: 0,
      onFailure: 'fail_run',
    },
    endNode,
  ],
  edges: [{ id: 'e1', from: 'draft', port: 'ok', to: 'done' }],
} as const

export const workflowDefinitionCases = [
  ['NodeIdSchema', 'draft', 'Bad Id'],
  ['PortSchema', 'ok', 'Not A Port'],
  ['InputNameSchema', 'topic', 'Topic'],
  ['WorkflowInputSchema', input, { ...input, maxChars: 0 }],
  ['AgentNodeSchema', agentNode, { ...agentNode, retries: 3 }],
  ['GateNodeSchema', gateNode, { ...gateNode, question: '' }],
  ['BranchConditionSchema', { kind: 'outcome', is: 'failed' }, { kind: 'outcome', is: 'maybe' }],
  ['BranchRuleSchema', branchNode.rules[0], { id: 'good' }],
  ['BranchNodeSchema', branchNode, { ...branchNode, rules: [] }],
  ['JoinNodeSchema', joinNode, { ...joinNode, mode: 'first' }],
  ['EndNodeSchema', endNode, { ...endNode, kind: 'agent' }],
  ['WorkflowNodeSchema', gateNode, { ...gateNode, kind: 'loop' }],
  ['WorkflowEdgeSchema', edge, { ...edge, to: '' }],
  [
    'WorkflowLayoutSchema',
    { nodes: { a: { x: 16, y: 32 } } },
    { nodes: { a: { x: Number.NaN, y: 0 } } },
  ],
  ['WorkflowDefinitionSchema', workflowDefinition, { ...workflowDefinition, nodes: [] }],
  ['ValidationCodeSchema', 'cycle', 'nope'],
  ['ValidationIssueSchema', validation.issues[0], { ...validation.issues[0], severity: 'fatal' }],
  ['ValidationResultSchema', validation, { ok: true }],
  ['WorkflowVersionSummarySchema', versionSummary, { ...versionSummary, hash: 'short' }],
  ['WorkflowSummarySchema', workflowSummary, { id: 'wf-1' }],
  ['WorkflowDeleteWithRunsSchema', { confirm: 'Release notes' }, { confirm: '' }],
  ['WorkflowDeletedWithRunsSchema', { deletedRuns: 2 }, { deletedRuns: -1 }],
  [
    'WorkflowListSchema',
    {
      items: [workflowSummary],
      inventory: {
        definitions: 1,
        versions: 2,
        bytes: 800,
        maxDefinitions: 200,
        maxVersionsPerDefinition: 20,
      },
    },
    { items: [] },
  ],
  ['WorkflowVersionSchema', version, { ...version, definition: {} }],
  [
    'WorkflowDetailSchema',
    { ...workflowSummary, versions: [versionSummary], latest: version },
    { ...workflowSummary },
  ],
  [
    'WorkflowValidateSchema',
    { definition: workflowDefinition },
    { definition: workflowDefinition, extra: 1 },
  ],
  ['WorkflowCreateSchema', { definition: workflowDefinition }, {}],
  [
    'WorkflowVersionCreateSchema',
    { baseVersion: 1, definition: workflowDefinition },
    { definition: workflowDefinition },
  ],
  ['PortableAgentSchema', { name: 'Builder', role: null }, { name: '' }],
  ['PortableNodeSchema', portable.nodes[0], { ...portable.nodes[0], agent: undefined }],
  ['WorkflowExportRequestSchema', { removePaths: ['nodes[0].instruction'] }, { removePaths: [''] }],
  [
    'WorkflowExportSchema',
    {
      format: 'score.workflow/1',
      scrubbed: true,
      workflowId: 'wf-1',
      version: 1,
      portable,
      changes: [{ path: 'nodes[0].instruction', before: 'sk-x', after: '[redacted]' }],
      validation,
    },
    { format: 'other', scrubbed: true },
  ],
] as const satisfies readonly WorkflowCase[]
