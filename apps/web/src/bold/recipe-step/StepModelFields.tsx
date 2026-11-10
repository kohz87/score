import type { AgentSummary } from '@score/contract'
import { useAgentEfforts } from '../efforts/effort-queries.ts'
import { useModelChoices } from '../models/use-model-choices.ts'
import type { AgentNode, Commit } from '../../routes/workflows/node-inspector-types.ts'
import type { Draft } from '../../routes/workflows/workflow-model.ts'
import { pinFromValue, pinValue, setStepPin } from './step-pins.ts'

/**
 * A step's own model and effort (decision 183, mock-up 28-tasks-recipe): "Its own" follows the agent, or one of the
 * models `/model` lists for that agent (a coding agent: its program's) and the levels it takes. They apply to this step
 * only, and never follow the chat's /model.
 */
export function StepModelFields({
  draft,
  node,
  agents,
  commit,
}: {
  draft: Draft
  node: AgentNode
  agents: AgentSummary[]
  commit: Commit
}) {
  const agent = agents.find((item) => item.id === node.agentId)
  const choices = useModelChoices(agent, '')
  const levels = useAgentEfforts(agent?.id ?? null).data?.levels ?? []
  const current = pinValue(node.model)
  const listed = [...choices.aliases, ...choices.models].some(
    (choice) => pinValue({ model: choice.value, provider: choice.provider ?? null }) === current,
  )
  const group = (label: string, items: typeof choices.models) =>
    items.length > 0 && (
      <optgroup label={label}>
        {items.map((choice) => (
          <option
            key={`${choice.provider ?? ''}:${choice.value}`}
            value={pinValue({ model: choice.value, provider: choice.provider ?? null })}
          >
            {choice.label}
            {choice.detail ? ` · ${choice.detail}` : ''}
          </option>
        ))}
      </optgroup>
    )
  return (
    <div className="bold-recipes-inspector-grid">
      <label className="orch-field">
        <span>Model</span>
        <select
          value={current}
          disabled={!agent}
          onChange={(event) =>
            commit(
              setStepPin(draft, node.id, { model: pinFromValue(event.target.value) }),
              `model:${node.id}`,
            )
          }
        >
          <option value="">Its own</option>
          {node.model && !listed && <option value={current}>{node.model.model}</option>}
          {group('Aliases', choices.aliases)}
          {group(choices.coding ? choices.programGroup : 'Models it can use', choices.models)}
        </select>
      </label>
      <label className="orch-field">
        <span>Effort</span>
        <select
          value={node.effort ?? ''}
          disabled={!agent}
          onChange={(event) =>
            commit(
              setStepPin(draft, node.id, { effort: event.target.value || undefined }),
              `effort:${node.id}`,
            )
          }
        >
          <option value="">Its own</option>
          {node.effort && !levels.includes(node.effort) && (
            <option value={node.effort}>{node.effort}</option>
          )}
          {levels.map((level) => (
            <option key={level} value={level}>
              {level}
            </option>
          ))}
        </select>
      </label>
    </div>
  )
}
