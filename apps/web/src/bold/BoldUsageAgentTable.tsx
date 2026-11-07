import type { AgentSummary, Reports } from '@score/contract'
import { AgentGlyph } from '../components/AgentGlyph.tsx'
import { formatDuration, formatPercent } from '../routes/reports/reports-format.ts'
import { agentFor } from './bold-usage-model.ts'

const noFigure = (why: string) => <span aria-label={why}>—</span>

export function ByAgentTable({
  report,
  agents,
  money,
}: {
  report: Reports | undefined
  agents: AgentSummary[]
  money: (usd: number | null) => string
}) {
  const spendCell = (row: Reports['byAgent'][number]) =>
    row.spendBasis === 'unknown' ? (
      <span aria-label="This coding agent’s CLI gave no cost">unknown</span>
    ) : row.spendBasis === 'estimated' ? (
      `${money(row.spendUsd)} estimated`
    ) : (
      money(row.spendUsd)
    )
  return (
    <section className="card usage-figure usage-by-agent" aria-labelledby="usage-by-agent-title">
      <h3 id="usage-by-agent-title">By agent</h3>
      {!report ? (
        <p role="status" className="usage-loading">
          Loading the table…
        </p>
      ) : report.byAgent.length === 0 && !report.unattributed ? (
        <p className="usage-empty">No agents yet.</p>
      ) : (
        <div
          className="usage-table-scroll"
          role="region"
          aria-label="By agent table, scroll to see all columns"
          tabIndex={0}
        >
          <table className="usage-table usage-agent-table" aria-labelledby="usage-by-agent-title">
            <thead>
              <tr>
                <th scope="col">Agent</th>
                <th scope="col">Jobs done</th>
                <th scope="col">Runs</th>
                <th scope="col">Median time</th>
                <th scope="col">First-time pass</th>
                <th scope="col">Cache hits</th>
                <th scope="col">Spend</th>
              </tr>
            </thead>
            <tbody>
              {report.byAgent.map((row) => {
                const agent = agentFor(agents, row.agentId)
                return (
                  <tr key={row.agentId}>
                    <th scope="row">
                      <span className="usage-agent-cell">
                        <AgentGlyph agent={agent} size="xs" bare decorative />
                        {agent.name}
                      </span>
                    </th>
                    <td>{row.finished}</td>
                    <td>{row.runs}</td>
                    <td>{formatDuration(row.medianSec)}</td>
                    <td>
                      {row.firstPassRate !== null
                        ? formatPercent(row.firstPassRate)
                        : /review/i.test(agent.role)
                          ? 'n/a, reviews'
                          : noFigure('No reviewed tasks in this range')}
                    </td>
                    <td>
                      {row.cacheHitRate === null
                        ? noFigure('Hermes gave no cache figures')
                        : formatPercent(row.cacheHitRate)}
                    </td>
                    <td>{spendCell(row)}</td>
                  </tr>
                )
              })}
              {report.unattributed && (
                <tr>
                  <th scope="row">Unknown agent</th>
                  <td>—</td>
                  <td>{report.unattributed.runs}</td>
                  <td>—</td>
                  <td>—</td>
                  <td>—</td>
                  <td>—</td>
                </tr>
              )}
            </tbody>
          </table>
        </div>
      )}
    </section>
  )
}
