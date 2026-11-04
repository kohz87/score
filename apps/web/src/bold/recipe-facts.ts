import type { WorkflowDefinition } from '@score/contract'

/**
 * What a recipe does, in one line for its card in the library (mock-up 23-recipes-library): the steps, who does them,
 * the approval it asks for, and the inputs a run needs.
 */
export function recipeFacts(definition: WorkflowDefinition): string {
  const steps = definition.nodes.filter((node) => node.kind !== 'end')
  const agents: string[] = []
  for (const node of definition.nodes)
    if (node.kind === 'agent' && !agents.includes(node.agentId)) agents.push(node.agentId)
  const gates = definition.nodes.filter((node) => node.kind === 'gate')
  const endIds = new Set(definition.nodes.filter((node) => node.kind === 'end').map((n) => n.id))
  const approval =
    gates.length === 0
      ? ''
      : gates.some((gate) =>
            definition.edges.some((edge) => edge.from === gate.id && endIds.has(edge.to)),
          )
        ? 'your approval before it ends'
        : 'your approval at a gate'
  const who = [agents.join(' → '), approval].filter((part) => part !== '').join(', ')
  const inputs = definition.inputs.map((input) => input.name)
  return [
    `${steps.length} ${steps.length === 1 ? 'step' : 'steps'}`,
    who,
    inputs.length > 0 ? `${inputs.length === 1 ? 'input' : 'inputs'}: ${inputs.join(', ')}` : '',
  ]
    .filter((part) => part !== '')
    .join(' · ')
}
