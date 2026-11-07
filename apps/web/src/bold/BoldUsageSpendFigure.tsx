import type { AgentSummary, Reports } from '@score/contract'
import { useId, useState } from 'react'
import { AgentGlyph } from '../components/AgentGlyph.tsx'
import { onTeam } from './bold-agents.ts'
import { agentFor, chartTone } from './bold-usage-model.ts'

export function SpendFigure({
  report,
  agents,
  money,
}: {
  report: Reports
  agents: AgentSummary[]
  money: (usd: number | null) => string
}) {
  const [showTable, setShowTable] = useState(false)
  const uid = useId().replace(/:/g, '')
  const tableId = `usage-spend-table-${uid}`
  const max = Math.max(0, ...report.byAgent.map((row) => row.spendUsd ?? 0))
  // A coding agent's figure can be an estimate (subscription work at API prices) or unknown: say so beside the number.
  const spendText = (row: { spendUsd: number | null; spendBasis?: string }) =>
    row.spendBasis === 'unknown'
      ? 'unknown'
      : row.spendBasis === 'estimated'
        ? `${money(row.spendUsd)} estimated`
        : money(row.spendUsd)
  const rows = report.byAgent
    // 3.7.13 (owner): a removed agent with nothing spent in the period is noise; one that spent stays, so totals add up.
    .filter((row) => {
      // Until the agents load nothing is hidden, so a row doesn't flicker in.
      if (row.spendUsd !== null || agents.length === 0) return true
      const known = agents.find((agent) => agent.id === row.agentId)
      return known !== undefined && onTeam(known)
    })
    .map((row) => ({
      ...row,
      agent: agentFor(agents, row.agentId),
    }))
    .sort((a, b) => {
      if (a.spendUsd === null) return b.spendUsd === null ? 0 : 1
      if (b.spendUsd === null) return -1
      return b.spendUsd - a.spendUsd || a.agent.name.localeCompare(b.agent.name)
    })

  return (
    <section className="card usage-figure" aria-labelledby={`usage-spend-title-${uid}`}>
      <header className="row wrap usage-figure-head">
        <h3 id={`usage-spend-title-${uid}`}>Spend by agent</h3>
        {rows.length > 0 && (
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
      {rows.length === 0 ? (
        <p className="usage-empty">No agents yet.</p>
      ) : (
        <div
          className="usage-spend"
          role="img"
          aria-label={`Spend by agent: ${rows
            .map((row) => `${row.agent.name} ${spendText(row)}`)
            .join(', ')}.`}
        >
          {rows.map((row) => {
            const color = chartTone(row.agent)
            const width = row.spendUsd === null || max === 0 ? 0 : (row.spendUsd / max) * 80
            return (
              <div className="usage-spend-row" key={row.agentId}>
                <span className="usage-spend-name">
                  <AgentGlyph
                    agent={{ ...row.agent, style: { ...row.agent.style, color } }}
                    size="xs"
                    bare
                    decorative
                  />
                  {row.agent.name}
                </span>
                <span className="usage-spend-bar-wrap">
                  <span
                    className="usage-spend-bar"
                    title={`${row.agent.name}: ${spendText(row)}`}
                    style={{ width: `${width}%`, background: color }}
                  />
                  <span className="usage-spend-value">{spendText(row)}</span>
                </span>
              </div>
            )
          })}
        </div>
      )}
      <p className="small muted usage-note">
        Free models count as $0, where providers report it.
        {report.totals.spendEstimated
          ? ' An estimated amount is what subscription work would cost at API prices.'
          : ''}
        {report.totals.spendExcluded?.length
          ? ` ${report.totals.spendExcluded.length === 1 ? 'One coding agent gave' : 'Some coding agents gave'} no cost and ${report.totals.spendExcluded.length === 1 ? 'is' : 'are'} left out.`
          : ''}
      </p>
      <table
        id={tableId}
        className={showTable ? 'usage-table' : 'usage-sr-only'}
        aria-label="Spend by agent"
      >
        <thead>
          <tr>
            <th scope="col">Agent</th>
            <th scope="col">Spend</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.agentId}>
              <th scope="row">{row.agent.name}</th>
              <td>{spendText(row)}</td>
            </tr>
          ))}
        </tbody>
      </table>
    </section>
  )
}
