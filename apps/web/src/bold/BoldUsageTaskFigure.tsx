import type { AgentSummary, Reports } from '@score/contract'
import { useId, useState } from 'react'
import { agentFor, dayLabel, dayTitle } from './bold-usage-model.ts'

export function TaskFigure({ report, agents }: { report: Reports; agents: AgentSummary[] }) {
  const [showTable, setShowTable] = useState(false)
  const uid = useId().replace(/:/g, '')
  const tableId = `usage-tasks-table-${uid}`
  const count = (day: Reports['byDay'][number], id: string) => {
    const n = day.perAgent[id] ?? 0
    return Number.isFinite(n) && n > 0 ? n : 0
  }
  const totals = report.byDay.map((day) =>
    Object.keys(day.perAgent).reduce((sum, id) => sum + count(day, id), 0),
  )
  const max = Math.max(0, ...totals)
  const agentIds = new Set<string>()
  for (const day of report.byDay)
    for (const [id, n] of Object.entries(day.perAgent)) if (n > 0) agentIds.add(id)
  const known = agents.filter((agent) => agentIds.has(agent.id))
  const unknown = [...agentIds]
    .filter((id) => !agents.some((agent) => agent.id === id))
    .map((id) => agentFor(agents, id))
  const series = [...known, ...unknown]
  const summary = report.byDay
    .map((day, index) => `${dayTitle(day.date)}: ${totals[index]}`)
    .join(', ')

  return (
    <section className="card usage-figure" aria-labelledby={`usage-tasks-title-${uid}`}>
      <header className="row wrap usage-figure-head">
        <h3 id={`usage-tasks-title-${uid}`}>Jobs done per day</h3>
        {report.totals.tasksFinished > 0 && (
          <button
            type="button"
            className="link"
            aria-expanded={showTable}
            aria-controls={tableId}
            onClick={() => setShowTable((shown) => !shown)}
          >
            {showTable ? 'Hide table' : 'Show as table'}
          </button>
        )}
      </header>
      {report.totals.tasksFinished === 0 ? (
        <p className="usage-empty">No jobs finished in this range.</p>
      ) : (
        <div className="usage-jobs-chart">
          <div className="usage-jobs-bars" role="img" aria-label={`Jobs done: ${summary}.`}>
            {report.byDay.map((day, index) => {
              const total = totals[index] ?? 0
              // One busiest day: on a tie, the most recent (2026-10-28, two equal days showed two).
              const busiest = max > 0 && index === totals.lastIndexOf(max)
              const height = max > 0 ? Math.max((total / max) * 150, total ? 4 : 0) : 0
              return (
                <span
                  key={`${day.date}-${index}`}
                  className="usage-jobs-column"
                  data-day={day.date}
                  data-total={total}
                  title={`${dayTitle(day.date)}: ${total}`}
                >
                  {busiest && <span className="usage-jobs-value">{total}</span>}
                  <span
                    className={`usage-jobs-bar${busiest ? ' usage-jobs-bar--busiest' : ''}`}
                    data-part="bar"
                    style={{ height: `${height}px` }}
                  />
                </span>
              )
            })}
          </div>
          <div className="usage-jobs-labels" aria-hidden="true">
            {report.byDay.map((day, index) => (
              <span key={`${day.date}-${index}`} className="usage-jobs-label">
                {dayLabel(day.date, report.byDay.length, index)}
              </span>
            ))}
          </div>
        </div>
      )}
      {report.totals.tasksFinished > 0 && (
        <table
          id={tableId}
          className={showTable ? 'usage-table' : 'usage-sr-only'}
          aria-label="Jobs done per day, by agent"
        >
          <caption>Jobs done per day, by agent</caption>
          <thead>
            <tr>
              <th scope="col">Day</th>
              <th scope="col">Jobs done</th>
              {series.map((agent) => (
                <th key={agent.id} scope="col">
                  {agent.name}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {report.byDay.map((day, index) => (
              <tr key={`${day.date}-${index}`}>
                <th scope="row">{day.date}</th>
                <td>{totals[index]}</td>
                {series.map((agent) => (
                  <td key={agent.id}>{count(day, agent.id)}</td>
                ))}
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  )
}
