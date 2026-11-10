import type { AgentSummary } from '@score/contract'
import { Link } from 'react-router'
import { AgentGlyph } from '../../components/AgentGlyph.tsx'
import { agentDisplayName } from '../bold-agents.ts'
import type { Row } from './repeating-rows.ts'
import { nextWords, scheduleWords } from './schedule-words.ts'

// Tasks › Repeating (TR.2): the cells a row is made of, shared by the table and the phone cards.

export const recipePath = (id: string) => `/b/tasks/recipes/${encodeURIComponent(id)}`

export function WhenCell({ row, now }: { row: Row; now: Date }) {
  const next = nextWords(row.nextRunAt, now)
  return (
    <>
      {scheduleWords(row.schedule)}
      {next && <span className="bold-rj-sub">{next}</span>}
    </>
  )
}

export function AssignedCell({ row, agent }: { row: Row; agent: AgentSummary | undefined }) {
  if (row.kind === 'recipe')
    return (
      <span className="bold-rj-assigned">
        <span className="bold-rj-recipe-mark" aria-hidden="true" />
        <Link to={recipePath(row.id)}>Recipe · {row.title}</Link>
      </span>
    )
  return (
    <span className="bold-rj-assigned">
      {agent && <AgentGlyph agent={agent} size="xs" bare decorative />}
      {agent ? agentDisplayName(agent) : row.agentId}
    </span>
  )
}

export function ModelPill({ row }: { row: Row }) {
  return (
    <span
      className={`bold-rj-model${row.pinned ? ' is-pinned' : ''}${row.kind === 'recipe' ? ' is-step' : ''}`}
    >
      {row.model}
    </span>
  )
}

export function StateCell({ row }: { row: Row }) {
  return (
    <>
      <span className={`bold-rj-state${row.enabled ? ' is-on' : ''}`}>
        {row.enabled ? 'On' : 'Paused'}
      </span>
      {row.problem && (
        <span className="bold-rj-problem" data-protected="block">
          {row.problem}
        </span>
      )}
    </>
  )
}

export function RowActions({
  row,
  busy,
  onRun,
  onEdit,
}: {
  row: Row
  busy: boolean
  onRun: (row: Row) => void
  onEdit: (row: Row) => void
}) {
  return (
    <span className="bold-rj-actions">
      <button
        type="button"
        disabled={busy}
        aria-label={`Run ${row.title} now`}
        onClick={() => onRun(row)}
      >
        Run now
      </button>
      {row.kind === 'recipe' ? (
        <Link to={recipePath(row.id)} aria-label={`Edit ${row.title}`}>
          Edit
        </Link>
      ) : (
        <button type="button" aria-label={`Edit ${row.title}`} onClick={() => onEdit(row)}>
          Edit
        </button>
      )}
    </span>
  )
}
