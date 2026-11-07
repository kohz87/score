import type { AgentSummary, Reports } from '@score/contract'
import { useId } from 'react'
import { formatRate, formatTtft } from '../routes/chat/speed-format.ts'
import { onTeam } from './bold-agents.ts'
import { agentFor } from './bold-usage-model.ts'

/** 3.10.0: median time to first token and tokens per second per agent, measured by Score on its runs. */
export function SpeedByAgent({ report, agents }: { report: Reports; agents: AgentSummary[] }) {
  const uid = useId().replace(/:/g, '')
  const measured = new Map((report.speedByAgent ?? []).map((row) => [row.agentId, row]))
  const rows = report.byAgent
    .filter((row) => {
      if (measured.has(row.agentId) || agents.length === 0) return true
      const known = agents.find((agent) => agent.id === row.agentId)
      return known !== undefined && onTeam(known)
    })
    .map((row) => ({ agent: agentFor(agents, row.agentId), speed: measured.get(row.agentId) }))
    .sort((a, b) => a.agent.name.localeCompare(b.agent.name))
  return (
    <section className="card usage-figure" aria-labelledby={`usage-speed-title-${uid}`}>
      <header className="row wrap usage-figure-head">
        <h3 id={`usage-speed-title-${uid}`}>Speed by agent</h3>
      </header>
      {rows.length === 0 ? (
        <p className="usage-empty">No agents yet.</p>
      ) : (
        <table className="usage-table" aria-label="Speed by agent">
          <thead>
            <tr>
              <th scope="col">Agent</th>
              <th scope="col">First token (median)</th>
              <th scope="col">Avg tokens/s (median)</th>
              <th scope="col">Runs</th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ agent, speed }) => (
              <tr key={agent.id}>
                <th scope="row">{agent.name}</th>
                <td>{speed?.medianTtftMs != null ? formatTtft(speed.medianTtftMs) : '—'}</td>
                <td>
                  {speed?.medianTokensPerSecond != null
                    ? `${formatRate(speed.medianTokensPerSecond)} tok/s`
                    : '—'}
                </td>
                <td>{speed?.runs ?? 0}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
      <p className="small muted usage-note">
        Measured by Score on each run; a dash means no measured run in this period. Tokens/s is
        averaged over the whole reply, tool time included.
      </p>
    </section>
  )
}
