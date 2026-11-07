import type {
  BranchCondition,
  WorkflowDefinition,
  WorkflowNode,
  WorkflowNodeKind,
} from '@score/contract'

export type Draft = WorkflowDefinition
export type BranchNode = Extract<WorkflowNode, { kind: 'branch' }>

export const KIND_LABEL: Record<WorkflowNodeKind, string> = {
  agent: 'Agent step',
  gate: 'Gate',
  branch: 'Branch',
  join: 'Join',
  end: 'End',
}

export const KIND_HELP: Record<WorkflowNodeKind, string> = {
  agent: 'An agent does some work from your instruction.',
  gate: 'The run stops here until you approve or reject.',
  branch: 'Sends the run down one path, by the verdict, outcome or output of an earlier step.',
  join: 'Waits for every path that leads into it.',
  end: 'The run is finished when it gets here.',
}

interface PortInfo {
  id: string
  /** What the person reads: "when it is done", "when it fails". */
  label: string
}

/** The ports a node offers to connect from; none for an end. */
export function portsOf(node: WorkflowNode): PortInfo[] {
  switch (node.kind) {
    case 'agent':
      return [
        { id: 'ok', label: 'when done' },
        { id: 'failed', label: 'when it fails' },
      ]
    case 'gate':
      return [
        { id: 'ok', label: 'when approved' },
        { id: 'rejected', label: 'when rejected' },
      ]
    case 'branch':
      return [
        ...node.rules.map((rule) => ({ id: rule.id, label: describeCondition(rule.when) })),
        { id: 'default', label: 'otherwise' },
      ]
    case 'join':
      return [{ id: 'ok', label: 'when all arrived' }]
    case 'end':
      return []
  }
}

export function describeCondition(condition: BranchCondition): string {
  switch (condition.kind) {
    case 'verdict':
      return condition.is === 'passed' ? 'verdict passed' : 'verdict changes requested'
    case 'outcome':
      return condition.is === 'succeeded' ? 'step succeeded' : 'step failed'
    case 'output_contains':
      return `output contains "${condition.text}"`
  }
}

export function portLabel(node: WorkflowNode | undefined, port: string): string {
  return node ? (portsOf(node).find((p) => p.id === port)?.label ?? port) : port
}
