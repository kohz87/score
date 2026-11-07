import { WORKFLOW_LIMITS } from '@score/contract'
import { escapeRegExp } from './workflow-model-helpers.ts'
import type { Draft } from './workflow-model-types.ts'

export function addInput(draft: Draft): Draft {
  if (draft.inputs.length >= WORKFLOW_LIMITS.maxInputs) return draft
  const taken = new Set(draft.inputs.map((input) => input.name))
  let n = 1
  while (taken.has(`input${n}`)) n++
  return {
    ...draft,
    inputs: [
      ...draft.inputs,
      { name: `input${n}`, label: `Input ${n}`, required: true, maxChars: 2000 },
    ],
  }
}

export function removeInput(draft: Draft, name: string): Draft {
  return { ...draft, inputs: draft.inputs.filter((input) => input.name !== name) }
}

/** Renames an input and the `{{inputs.<name>}}` references in every template. */
export function renameInput(draft: Draft, from: string, to: string): Draft {
  if (from === to) return draft
  const ref = new RegExp(`(\\{\\{\\s*inputs\\.)${escapeRegExp(from)}(?=[\\s|}])`, 'g')
  return {
    ...draft,
    inputs: draft.inputs.map((input) => (input.name === from ? { ...input, name: to } : input)),
    nodes: draft.nodes.map((node) => {
      if (node.kind === 'agent')
        return { ...node, instruction: node.instruction.replace(ref, `$1${to}`) }
      if (node.kind === 'gate') return { ...node, question: node.question.replace(ref, `$1${to}`) }
      return node
    }),
  }
}
