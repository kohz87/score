import {
  ValidationCodeSchema,
  WorkflowDefinitionSchema,
  type ValidationCode,
  type ValidationIssue,
  type ValidationResult,
} from '@score/contract'
import type { Draft } from './workflow-model.ts'

// How the editor shows validation (PLAN 7.1b). The server's `ValidationResult` (one function for the editor, save and
// start) is the authority for graph rules; shape problems of a half-written draft (an empty instruction, no agent
// chosen yet) are found here with the contract's own schema, because the server refuses to look at a draft that is not
// shaped like a definition. Both end up as `EditorIssue`s attached to the node, edge or field they concern.

export type EditorIssueCode = ValidationCode | 'incomplete'

export interface EditorIssue {
  code: EditorIssueCode
  severity: 'error' | 'warning'
  nodeId: string | null
  edgeId: string | null
  field: string | null
  message: string
  /** What to do about it, in plain words. */
  help: string
}

/** Plain words per code. A `Record` over every code: adding a code to the contract fails the build until it is here. */
export const CODE_HELP: Record<ValidationCode, string> = {
  too_many_nodes: 'Remove a step, or split the work into two workflows.',
  too_many_edges: 'Remove some connections.',
  definition_too_large: 'Shorten instructions or questions.',
  steps_over_limit:
    'Every agent step can run up to retries + 1 times and a run may use at most 30 steps. Lower the retries or remove a step.',
  duplicate_node_id: 'Give each step its own name.',
  duplicate_edge_id: 'Remove the connection and draw it again.',
  duplicate_edge: 'The same connection is drawn twice. Remove one.',
  duplicate_input: 'Give each start input its own name.',
  unknown_node: 'A connection points at a step that isn’t there. Remove it or add the step back.',
  bad_port: 'That step has no such connection point. Remove the connection and draw it again.',
  no_root: 'Every workflow needs a first step: a step with nothing leading into it.',
  bad_root_kind: 'A workflow starts with an agent step or a gate, not a branch, join or end.',
  cycle:
    'The connections loop back. A workflow only goes forward; remove the connection that closes the loop.',
  unreachable_node: 'Nothing leads to this step, so it would never run. Connect it or remove it.',
  no_end: 'Add an End step and connect a path to it.',
  end_has_outgoing: 'An End finishes the run; remove the connection leaving it.',
  unrouted_failure:
    'This step says a failure goes to a repair path, but nothing is connected to “when it fails”. Connect it, or choose “failing stops the run”.',
  unrouted_rejection:
    'This gate says a rejection goes to another path, but nothing is connected to “when rejected”. Connect it, or choose “rejecting stops the run”.',
  failure_edge_with_fail_run:
    'A “when it fails” connection exists, but the step is set to stop the run on failure. Choose “route a failure” or remove the connection.',
  port_unconnected: 'Connect this to a next step so the run knows where to go.',
  branch_no_default: 'A branch always needs an “otherwise” path.',
  branch_duplicate_rule: 'Two rules on this branch are the same. Change or remove one.',
  branch_subject_invalid:
    'A branch looks at an agent step that runs before it. Choose one of its earlier agent steps.',
  branch_condition_unusable:
    'This rule can never match the step it looks at. Pick another condition or another step.',
  join_needs_inputs:
    'A join waits for at least two paths. Connect more paths into it, or remove it.',
  join_deadlock: 'This join would wait forever for a path that never arrives.',
  template_syntax:
    'A {{ }} reference isn’t written correctly. Use {{inputs.name}} or {{nodes.id.output}}.',
  template_unknown_input:
    'That start input doesn’t exist. Add it under “Start inputs” or fix the name.',
  template_unknown_node: 'That step doesn’t exist. Pick one from the suggestions.',
  template_self_reference: 'A step can’t read its own output.',
  template_forward_reference: 'A step can only read from steps that run before it.',
  template_not_ancestor:
    'A step can only read from steps that lead into it. Connect that step to this one, or read from another.',
  template_needs_default:
    'That step may be skipped, so there might be nothing to read. Add a fallback: {{nodes.id.output|default:"…"}}.',
  template_field_unavailable: 'Only agent steps have an output or a verdict.',
  agent_missing: 'Choose the agent for this step.',
  layout_unknown_node: 'The drawing positions a step that no longer exists.',
  coding_agent_unsupported: 'Open the step and pick one of those from the Agent list.',
  coding_permission_full:
    'Give it read-only or workspace access on its Team page, or choose another agent for this step.',
  coding_workers_need_units: 'Until that is set up, give this step a Hermes agent.',
}

export const ALL_CODES: readonly ValidationCode[] = ValidationCodeSchema.options

/** Fixed labels per field, for the "what is wrong with it" phrase of a shape problem. */
const FIELD_WORDS: Record<string, string> = {
  name: 'The workflow needs a name.',
  label: 'Give this step a title.',
  instruction: 'Write what this agent should do.',
  question: 'Write the question you will be asked.',
  agentId: 'Choose the agent for this step.',
  subject: 'Choose the agent step this branch looks at.',
  text: 'Write the text to look for.',
}

function fieldPhrase(field: string | null): string {
  const last = field?.split('.').pop() ?? ''
  return (Object.hasOwn(FIELD_WORDS, last) && FIELD_WORDS[last]) || 'Check this field.'
}

export function fromServer(issue: ValidationIssue): EditorIssue {
  return {
    code: issue.code,
    severity: issue.severity,
    nodeId: issue.nodeId,
    edgeId: issue.edgeId,
    field: issue.field,
    message: issue.message,
    help: CODE_HELP[issue.code],
  }
}

/** Problems of the draft's shape that stop it from being sent for validation at all. */
export function shapeIssues(draft: Draft): EditorIssue[] {
  const parsed = WorkflowDefinitionSchema.safeParse(draft)
  if (parsed.success) return []
  const issues: EditorIssue[] = []
  for (const issue of parsed.error.issues) {
    const [root, index, ...rest] = issue.path
    const tail = rest.map(String).join('.')
    let nodeId: string | null = null
    let field: string | null
    let scope = 'This workflow'
    if (root === 'nodes' && typeof index === 'number') {
      const node = draft.nodes[index]
      nodeId = node?.id ?? null
      field = tail || null
      scope = node ? node.label || node.id : 'A step'
    } else if (root === 'inputs' && typeof index === 'number') {
      field = `inputs[${index}].${tail}`
      scope = `Start input ${draft.inputs[index]?.label ?? index + 1}`
    } else if (root === 'edges' && typeof index === 'number') {
      field = tail || null
    } else field = String(root ?? '') || null
    const tooBig = issue.code === 'too_big'
    const message = tooBig
      ? `${nodeId ? '' : `${scope}: `}${field ?? 'a field'} is too long. ${issue.message}`
      : `${nodeId ? '' : `${scope}: `}${fieldPhrase(field)}`
    issues.push({
      code: 'incomplete',
      severity: 'error',
      nodeId,
      edgeId: null,
      field,
      message,
      help: 'Fill this in before the workflow can be saved.',
    })
  }
  return dedupe(issues)
}

function dedupe(issues: EditorIssue[]): EditorIssue[] {
  const seen = new Set<string>()
  return issues.filter((issue) => {
    const key = `${issue.code}|${issue.nodeId}|${issue.edgeId}|${issue.field}|${issue.message}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export function combine(shape: EditorIssue[], server: ValidationResult | undefined): EditorIssue[] {
  return dedupe([...shape, ...(server?.issues.map(fromServer) ?? [])])
}

export interface IssueIndex {
  all: EditorIssue[]
  byNode: Map<string, EditorIssue[]>
  byEdge: Map<string, EditorIssue[]>
  /** Not attached to a node or an edge (limits, inputs, no end). */
  general: EditorIssue[]
  errors: number
  warnings: number
}

export function indexIssues(issues: EditorIssue[]): IssueIndex {
  const byNode = new Map<string, EditorIssue[]>()
  const byEdge = new Map<string, EditorIssue[]>()
  const general: EditorIssue[] = []
  for (const issue of issues) {
    if (issue.edgeId) byEdge.set(issue.edgeId, [...(byEdge.get(issue.edgeId) ?? []), issue])
    else if (issue.nodeId) byNode.set(issue.nodeId, [...(byNode.get(issue.nodeId) ?? []), issue])
    else general.push(issue)
  }
  return {
    all: issues,
    byNode,
    byEdge,
    general,
    errors: issues.filter((issue) => issue.severity === 'error').length,
    warnings: issues.filter((issue) => issue.severity === 'warning').length,
  }
}

/** Issues that concern a node, including those on the edges that leave or enter it. */
export function issuesForNode(index: IssueIndex, draft: Draft, nodeId: string): EditorIssue[] {
  const own = index.byNode.get(nodeId) ?? []
  const viaEdges = draft.edges
    .filter((edge) => edge.from === nodeId || edge.to === nodeId)
    .flatMap((edge) => index.byEdge.get(edge.id) ?? [])
  return [...own, ...viaEdges]
}

export function worstSeverity(issues: readonly EditorIssue[]): 'error' | 'warning' | null {
  if (issues.some((issue) => issue.severity === 'error')) return 'error'
  return issues.length > 0 ? 'warning' : null
}

/** One line for the header: "2 problems to fix" / "Looks good". */
export function summaryLine(index: IssueIndex, checking: boolean): string {
  if (index.errors > 0)
    return `${index.errors} ${index.errors === 1 ? 'problem' : 'problems'} to fix`
  if (checking) return 'Checking…'
  if (index.warnings > 0)
    return `Ready to save, ${index.warnings} ${index.warnings === 1 ? 'warning' : 'warnings'}`
  return 'Looks good'
}
