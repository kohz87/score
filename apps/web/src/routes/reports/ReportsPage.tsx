import type { AgentSummary, ReportRange, Reports } from '@score/contract'
import { ReportRangeSchema } from '@score/contract'
import { Link, useSearchParams } from 'react-router'
import { AgentGlyph } from '../../components/AgentGlyph.tsx'
import { useStreamQuery } from '../../data/query-client.ts'
import { agentsQuery } from '../team/team-queries.ts'
import { TasksByDayChart } from './TasksByDayChart.tsx'
import { formatDuration, formatPercent, formatUsd } from './reports-format.ts'
import { reportCsvHref, reportRanges, useReports } from './reports-queries.ts'
import './reports.css'

function agentFor(agents: AgentSummary[], id: string): AgentSummary {
  return (
    agents.find((agent) => agent.id === id) ?? {
      id,
      name: id,
      role: '',
      style: { color: '#9aa0ab', shape: 'circle-dot' },
      status: 'idle',
      activity: null,
      model: { id: '', label: '' },
      served: false,
    }
  )
}

function Totals({ totals }: { totals: Reports['totals'] }) {
  const items: [string, string][] = [
    [totals.tasksFinished.toString(), 'tasks finished'],
    [totals.runs.toString(), 'agent runs'],
    [formatPercent(totals.firstPassRate), 'passed review first time'],
    [formatDuration(totals.medianTaskSec), 'median time per task'],
    [formatUsd(totals.spendUsd), 'model spend'],
  ]
  return (
    <section className="reports-card reports-totals" aria-label="In numbers">
      {items.map(([value, label]) => (
        <div key={label} className="reports-stat">
          <span className="reports-stat__value">{value}</span>
          <span className="reports-stat__label">{label}</span>
        </div>
      ))}
    </section>
  )
}

function TimeSplit({ report, agents }: { report: Reports; agents: AgentSummary[] }) {
  return (
    <section className="reports-card reports-split" aria-labelledby="reports-split-title">
      <h2 id="reports-split-title">Where each agent&apos;s time goes</h2>
      {report.timeSplit.length === 0 && <p className="reports-empty">No agents yet.</p>}
      {report.timeSplit.map((row) => {
        const agent = agentFor(agents, row.agentId)
        return (
          <div key={row.agentId} className="reports-split__row">
            <div className="reports-split__head">
              <span className="reports-glyph reports-glyph--22">
                <AgentGlyph agent={agent} size="sm" decorative />
              </span>
              <span className="reports-split__name">{agent.name}</span>
              <span className="reports-split__working">{row.workingPct}% working</span>
            </div>
            <div
              className="reports-bar"
              role="img"
              aria-label={`${agent.name}: ${row.workingPct}% working, ${row.waitingOnYouPct}% waiting on you, ${row.waitingOnAgentPct}% waiting on another agent`}
            >
              <span
                className="reports-bar__working"
                style={{ width: `${row.workingPct}%`, background: agent.style.color }}
              />
              <span className="reports-bar__you" style={{ width: `${row.waitingOnYouPct}%` }} />
              <span className="reports-bar__agent" style={{ width: `${row.waitingOnAgentPct}%` }} />
            </div>
          </div>
        )
      })}
      <ul className="reports-legend" aria-label="Legend">
        <li>
          <span className="reports-swatch reports-swatch--working" />
          Working
        </li>
        <li>
          <span className="reports-swatch reports-swatch--you" />
          Waiting on you
        </li>
        <li>
          <span className="reports-swatch reports-swatch--agent" />
          Waiting on another agent
        </li>
      </ul>
    </section>
  )
}

function ByAgent({ report, agents }: { report: Reports; agents: AgentSummary[] }) {
  return (
    <section className="reports-card reports-table-card" aria-labelledby="reports-agents-title">
      <h2 id="reports-agents-title">By agent</h2>
      <div className="reports-table-scroll">
        <table className="reports-table" aria-labelledby="reports-agents-title">
          <thead>
            <tr>
              <th scope="col">Agent</th>
              <th scope="col">Finished</th>
              <th scope="col">Runs</th>
              <th scope="col">Median time</th>
              <th scope="col">First-time pass</th>
              <th scope="col" className="reports-table__right">
                Spend
              </th>
            </tr>
          </thead>
          <tbody>
            {report.byAgent.map((row) => {
              const agent = agentFor(agents, row.agentId)
              return (
                <tr key={row.agentId}>
                  <th scope="row">
                    <span className="reports-table__agent">
                      <span className="reports-glyph reports-glyph--26">
                        <AgentGlyph agent={agent} size="sm" decorative />
                      </span>
                      {agent.name}
                    </span>
                  </th>
                  <td>{row.finished}</td>
                  <td>{row.runs}</td>
                  <td>{formatDuration(row.medianSec)}</td>
                  <td>
                    {row.firstPassRate !== null ? (
                      formatPercent(row.firstPassRate)
                    ) : /review/i.test(agent.role) ? (
                      'n/a, reviews'
                    ) : (
                      <span aria-label="No reviewed tasks in this range">—</span>
                    )}
                  </td>
                  <td className="reports-table__right reports-table__spend">
                    {formatUsd(row.spendUsd)}
                  </td>
                </tr>
              )
            })}
          </tbody>
        </table>
      </div>
    </section>
  )
}

function Approvals({ approvals }: { approvals: Reports['approvals'] }) {
  const { asked, approved, denied } = approvals
  const share = (n: number) => (asked > 0 ? (n / asked) * 100 : 0)
  return (
    <section className="reports-approvals" aria-labelledby="reports-approvals-title">
      <h2 id="reports-approvals-title">Your approvals</h2>
      <div className="reports-approvals__stats">
        <div className="reports-approvals__stat">
          <span className="reports-stat__value">{asked}</span>
          <span>asked</span>
        </div>
        <div className="reports-approvals__stat">
          <span className="reports-stat__value">{formatDuration(approvals.medianWaitSec)}</span>
          <span>median wait</span>
        </div>
      </div>
      <div className="reports-approvals__bar" aria-hidden="true">
        <span className="reports-approvals__approved" style={{ width: `${share(approved)}%` }} />
        <span className="reports-approvals__denied" style={{ width: `${share(denied)}%` }} />
      </div>
      <div className="reports-approvals__counts">
        <span>{approved} approved</span>
        <span>{denied} denied</span>
      </div>
      {approvals.insight && <p className="reports-approvals__insight">{approvals.insight}</p>}
      <Link to="/settings#rules">Review rules</Link>
    </section>
  )
}

export function ReportsPage() {
  const [params, setParams] = useSearchParams()
  const parsed = ReportRangeSchema.safeParse(params.get('range'))
  const range: ReportRange = parsed.success ? parsed.data : '7d'
  const reports = useReports(range)
  const agents = useStreamQuery(agentsQuery).data ?? []
  const report = reports.data

  function setRange(next: ReportRange) {
    setParams((current) => {
      const copy = new URLSearchParams(current)
      copy.set('range', next)
      return copy
    })
  }

  return (
    <div className="reports">
      <section className="reports-hero">
        <div className="reports-hero__text">
          <h1>Reports</h1>
          <p className="reports-hero__summary" aria-live="polite">
            {report?.summary ?? (reports.isError ? 'Reports could not be loaded.' : 'Loading…')}
          </p>
        </div>
        <div className="reports-hero__actions">
          <div className="reports-tabs" role="group" aria-label="Range">
            {reportRanges.map(({ id, label }) => (
              <button
                key={id}
                type="button"
                aria-pressed={range === id}
                onClick={() => setRange(id)}
              >
                {label}
              </button>
            ))}
          </div>
          <a className="reports-export" href={reportCsvHref(range)} download>
            Export CSV
          </a>
        </div>
      </section>
      {reports.isError && (
        <p role="alert" className="reports-error">
          Reports could not be loaded.{' '}
          <button type="button" onClick={() => void reports.refetch()}>
            Try again
          </button>
        </p>
      )}
      {report && (
        <>
          <Totals totals={report.totals} />
          <div className="reports-row">
            <section className="reports-card reports-chart" aria-labelledby="reports-chart-title">
              <h2 id="reports-chart-title">Tasks finished, by day</h2>
              <TasksByDayChart byDay={report.byDay} agents={agents} />
            </section>
            <TimeSplit report={report} agents={agents} />
          </div>
          <div className="reports-row">
            <ByAgent report={report} agents={agents} />
            <Approvals approvals={report.approvals} />
          </div>
        </>
      )}
    </div>
  )
}
