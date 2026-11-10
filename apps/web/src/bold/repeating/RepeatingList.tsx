import type { AgentSummary } from '@score/contract'
import { Link } from 'react-router'
import {
  AssignedCell,
  ModelPill,
  RowActions,
  StateCell,
  WhenCell,
  recipePath,
} from './RepeatingCells.tsx'
import type { Row } from './repeating-rows.ts'
import { nextWords, scheduleWords } from './schedule-words.ts'

// Tasks › Repeating (TR.2): the table (mock-up 28-tasks-main) and, on a phone, the cards (28-tasks-phone).

type Props = {
  rows: readonly Row[]
  agents: readonly AgentSummary[]
  now: Date
  busy: boolean
  onRun: (row: Row) => void
  onEdit: (row: Row) => void
}

const agentOf = (agents: readonly AgentSummary[], row: Row) =>
  agents.find((agent) => agent.id === row.agentId)

function Title({ row, onEdit }: { row: Row; onEdit: (row: Row) => void }) {
  return row.kind === 'recipe' ? (
    <Link className="bold-rj-title" to={recipePath(row.id)}>
      {row.title}
    </Link>
  ) : (
    <button type="button" className="bold-rj-title" onClick={() => onEdit(row)}>
      {row.title}
    </button>
  )
}

export function RepeatingTable({ rows, agents, now, busy, onRun, onEdit }: Props) {
  return (
    <div className="bold-rj-table-wrap">
      <table className="bold-rj-table">
        <thead>
          <tr>
            <th scope="col">JOB</th>
            <th scope="col">WHEN</th>
            <th scope="col">ASSIGNED TO</th>
            <th scope="col">MODEL</th>
            <th scope="col">RESULTS GO TO</th>
            <th scope="col">STATE</th>
            <th scope="col">
              <span className="bold-rj-hidden">Actions</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.key}>
              <td>
                <Title row={row} onEdit={onEdit} />
                {row.what && <span className="bold-rj-sub">{row.what}</span>}
              </td>
              <td>
                <WhenCell row={row} now={now} />
              </td>
              <td>
                <AssignedCell row={row} agent={agentOf(agents, row)} />
              </td>
              <td>
                <ModelPill row={row} />
              </td>
              <td>{row.results}</td>
              <td>
                <StateCell row={row} />
              </td>
              <td className="bold-rj-actions-cell">
                <RowActions row={row} busy={busy} onRun={onRun} onEdit={onEdit} />
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  )
}

export function RepeatingCards({ rows, agents, now, busy, onRun, onEdit }: Props) {
  return (
    <ul className="bold-rj-cards">
      {rows.map((row) => {
        const next = nextWords(row.nextRunAt, now)
        return (
          <li key={row.key}>
            <div className="bold-rj-card-head">
              <Title row={row} onEdit={onEdit} />
              <StateCell row={row} />
            </div>
            <div className="bold-rj-card-when">
              {scheduleWords(row.schedule)}
              {next ? ` · ${next}` : ''}
            </div>
            <div className="bold-rj-card-who">
              <AssignedCell row={row} agent={agentOf(agents, row)} />
              <ModelPill row={row} />
            </div>
            <RowActions row={row} busy={busy} onRun={onRun} onEdit={onEdit} />
          </li>
        )
      })}
    </ul>
  )
}
