import type { AgentSummary } from '@score/contract'
import { AgentGlyph } from '../../components/AgentGlyph.tsx'
import { boldAgentScreenLink } from '../bold-links.ts'
import { Node } from './Node.tsx'
import type { LayerId } from './job-map-model.ts'
import type { SubagentLayerModel } from './subagent-layer-model.ts'

/** The SUBAGENTS node: one node for the lead's own helpers, selectable like the other layers (SA.3 part 8). */
export function SubagentNode({
  layer,
  model,
  selected,
  onPick,
  pulse,
}: {
  layer: LayerId
  model: SubagentLayerModel
  selected: LayerId | null
  onPick: (layer: LayerId) => void
  pulse: boolean
}) {
  return (
    <Node
      layer={layer}
      selected={selected}
      onPick={onPick}
      tone="subagents"
      pulse={pulse}
      label={`Subagents layer: ${model.title}, ${model.detail}`}
      className="jobmap-subagents"
    >
      <span className="jobmap-kicker">Subagents</span>
      <strong>{model.title}</strong>
      <span className="jobmap-sub">{model.detail}</span>
    </Node>
  )
}

/**
 * The selected SUBAGENTS layer's detail: the three facts, then each subagent's state, goal, time and cost. Status only:
 * the steps stay in Watch, and nothing here asks the person to decide.
 */
export function SubagentPanel({
  model,
  lead,
  leadName,
}: {
  model: SubagentLayerModel
  lead: AgentSummary | undefined
  leadName: string
}) {
  return (
    <aside className="jobmap-subagents-panel" aria-label="Subagents detail">
      <h3 className="jobmap-subagents-heading">
        {lead && <AgentGlyph agent={lead} size="xs" bare decorative />}
        {leadName}’s subagents
      </h3>
      <dl className="jobmap-subagents-facts">
        <div>
          <dt>At once</dt>
          <dd>{model.atOnce}</dd>
        </div>
        <div>
          <dt>This job</dt>
          <dd>{model.thisJob}</dd>
        </div>
        <div>
          <dt>Their cost</dt>
          <dd>{model.cost}</dd>
        </div>
      </dl>
      <ul className="jobmap-subagents-rows" aria-label="Subagents">
        {model.rows.map((row) => (
          <li key={row.id} data-state={row.state}>
            <span className="jobmap-subagents-state">{row.state}</span>
            <span className="jobmap-subagents-goal">{row.goal}</span>
            <span className="jobmap-subagents-meta">{row.meta}</span>
          </li>
        ))}
      </ul>
      <p className="jobmap-subagents-note">
        Each subagent’s steps open in Watch. They can’t post in the chat or hand off: only{' '}
        {leadName} reports back.
      </p>
      {lead && (
        <a className="jobmap-subagents-watch" href={boldAgentScreenLink(lead.id)}>
          Open {leadName} in Watch
        </a>
      )}
    </aside>
  )
}
