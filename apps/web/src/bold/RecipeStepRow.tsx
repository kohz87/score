import type { AgentSummary } from '@score/contract'
import { AgentGlyph } from '../components/AgentGlyph.tsx'
import { TrashIcon } from './BoldIcons.tsx'
import { StepPins } from './recipe-step/StepPins.tsx'
import {
  RECIPE_STEP_LABEL,
  RECIPE_STEP_MARK,
  targetStepLabel,
  type RecipeAnalysis,
  type RecipeRow,
} from './recipe-model.ts'

export function RecipeStepRow({
  row,
  analysis,
  agents,
  editable,
  selected,
  moveProblems,
  onSelect,
  onMove,
  onRemove,
  onTarget,
}: {
  row: RecipeRow
  analysis: RecipeAnalysis
  agents: AgentSummary[]
  editable: boolean
  selected: boolean
  moveProblems: { up: string | null; down: string | null }
  onSelect: () => void
  onMove: (direction: -1 | 1) => void
  onRemove: () => void
  onTarget: (nodeId: string, port: string, target: string | null) => void
}) {
  const node = row.node
  const label = node.label || node.id
  const agent = node.kind === 'agent' ? agents.find((item) => item.id === node.agentId) : undefined
  const incoming = row.incoming
    .map((edge) => analysis.order.find((item) => item.id === edge.from)?.label || edge.from)
    .join(', ')
  return (
    <li className={`bold-recipes-row${selected ? ' sel' : ''}`} data-recipe-step={node.id}>
      <div className="bold-recipes-rowmain">
        <button
          type="button"
          className={`bold-step${selected ? ' sel' : ''}`}
          aria-current={selected ? 'true' : undefined}
          onClick={onSelect}
        >
          <span className="mono small muted">{row.index + 1}</span>
          {agent ? (
            <AgentGlyph agent={agent} size="xs" decorative />
          ) : node.kind === 'agent' ? (
            <span className="bold-step-mark bold-step-mark--missing" aria-hidden="true">
              ?
            </span>
          ) : (
            <span className="bold-step-mark" aria-hidden="true">
              {RECIPE_STEP_MARK[node.kind]}
            </span>
          )}
          <span className="grow bold-step-copy">
            <b>{label}</b>
            <span className="small muted">
              {RECIPE_STEP_LABEL[node.kind]}
              {node.kind === 'agent'
                ? ` · ${node.agentId || 'no agent'} · retries ${node.retries}`
                : ''}
            </span>
            {node.kind === 'join' && (
              <span className="small muted">Waits for {incoming || 'nothing yet'}.</span>
            )}
            {node.kind === 'branch' && (
              <span className="small muted">
                Looks at{' '}
                {analysis.order.find((item) => item.id === node.subject)?.label ||
                  node.subject ||
                  'no step yet'}
                .
              </span>
            )}
          </span>
        </button>
        {node.kind === 'agent' && <StepPins node={node} index={row.index} onChange={onSelect} />}
        <div className="bold-recipes-rowactions">
          <button
            type="button"
            className="icon-btn sm"
            data-move="up"
            aria-label={`Move ${label} up`}
            title={moveProblems.up ?? `Move ${label} up`}
            disabled={!editable || moveProblems.up !== null}
            onClick={() => onMove(-1)}
          >
            ↑
          </button>
          <button
            type="button"
            className="icon-btn sm"
            data-move="down"
            aria-label={`Move ${label} down`}
            title={moveProblems.down ?? `Move ${label} down`}
            disabled={!editable || moveProblems.down !== null}
            onClick={() => onMove(1)}
          >
            ↓
          </button>
          <button
            type="button"
            className="icon-btn sm bold-recipes-remove"
            aria-label={`Remove ${label}`}
            disabled={!editable}
            onClick={onRemove}
          >
            <TrashIcon />
          </button>
        </div>
      </div>
      {node.kind === 'branch' && row.routes.length > 0 && (
        <div className="bold-recipes-routes">
          {row.routes.map((route) => {
            const value = route.edges[0]?.to ?? ''
            const unknown = value && !analysis.order.some((node) => node.id === value)
            return (
              <label key={route.port} className="bold-recipes-route">
                <span>{route.label} →</span>
                <select
                  aria-label={`${label}: ${route.label} goes to`}
                  value={value}
                  disabled={!editable}
                  onChange={(event) => onTarget(node.id, route.port, event.target.value || null)}
                >
                  <option value="">Not connected</option>
                  {unknown && <option value={value}>Missing step {value}</option>}
                  {analysis.order
                    .filter((target) => target.id !== node.id)
                    .map((target) => (
                      <option key={target.id} value={target.id}>
                        {targetStepLabel(analysis, target.id)}
                      </option>
                    ))}
                </select>
              </label>
            )
          })}
        </div>
      )}
    </li>
  )
}
