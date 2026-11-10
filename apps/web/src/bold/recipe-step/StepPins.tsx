import type { AgentNode } from '../../routes/workflows/node-inspector-types.ts'
import './step-pins.css'

/**
 * The two pills on a step's row (mock-up 28-tasks-recipe): its model and its effort, "its own" or what is set, amber
 * when set. Choosing one selects the step, whose settings hold the choices.
 */
export function StepPins({
  node,
  index,
  onChange,
}: {
  node: AgentNode
  index: number
  onChange: () => void
}) {
  const pill = (what: 'Model' | 'Effort', value: string | undefined) => (
    <button
      type="button"
      className={`bold-pin${value ? ' bold-pin--set' : ''}`}
      aria-label={`${what} for step ${index + 1}: ${value ?? 'its own'}. Change`}
      onClick={onChange}
    >
      {value ?? 'its own'}
    </button>
  )
  return (
    <span className="bold-pins">
      {pill('Model', node.model?.model)}
      {pill('Effort', node.effort)}
    </span>
  )
}
