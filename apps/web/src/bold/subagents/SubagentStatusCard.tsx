import type { AgentSummary, SubagentRow } from '@score/contract'
import { useId, useState } from 'react'
import { Link } from 'react-router'
import { PHONE_QUERY, useMediaQuery } from '../../data/use-media.ts'
import { boldAgentScreenLink } from '../bold-links.ts'
import { agentDisplayName } from '../bold-agents.ts'
import {
  subagentCounts,
  subagentDoneText,
  subagentRowMeta,
  subagentRowState,
} from './subagent-model.ts'
import './subagents.css'

function Rows({ rows }: { rows: readonly SubagentRow[] }) {
  return (
    <>
      {rows.map((row) => {
        const state = subagentRowState(row)
        return (
          <div className={`bold-subagent-row${row.waitingOnYou ? ' is-waiting' : ''}`} key={row.id}>
            <span className={`bold-subagent-row-state is-${state.toLowerCase()}`}>{state}</span>
            <span className="bold-subagent-row-goal">{row.goal}</span>
            <span className="bold-subagent-row-meta">{subagentRowMeta(row)}</span>
          </div>
        )
      })}
    </>
  )
}

/**
 * SA.3: the card under the parent agent's message for the turn that started its subagents. A status display, not a
 * decision, so it is open to every theme. On a phone it is one button until the person opens it.
 */
export function SubagentStatusCard({
  rows,
  agent,
}: {
  rows: readonly SubagentRow[]
  agent: AgentSummary | undefined
}) {
  const phone = useMediaQuery(PHONE_QUERY)
  const [open, setOpen] = useState(false)
  const bodyId = useId()
  if (rows.length === 0) return null
  const title = `Subagents · ${subagentDoneText(rows)}`
  const counts = subagentCounts(rows)
  const waiting =
    counts.waiting === 0
      ? null
      : counts.waiting === 1
        ? 'One is waiting for you'
        : `${counts.waiting} are waiting for you`
  const name = agent ? agentDisplayName(agent) : rows[0]!.agentId
  const details = agent ? (
    <Link
      className="bold-subagent-details"
      to={boldAgentScreenLink(agent.id)}
      aria-label={`Details: ${name}’s subagents in Watch`}
    >
      Details
    </Link>
  ) : null

  if (phone)
    return (
      <div>
        <button
          type="button"
          className="bold-subagent-collapse"
          aria-expanded={open}
          aria-controls={bodyId}
          onClick={() => setOpen((value) => !value)}
        >
          <span className="bold-subagent-collapse-text">
            <span className="bold-subagent-collapse-title">{title}</span>
            {waiting && <span className="bold-subagent-collapse-sub">{waiting}</span>}
          </span>
          <svg
            className="bold-subagent-chevron"
            aria-hidden="true"
            width="18"
            height="18"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth="2"
            strokeLinecap="round"
            strokeLinejoin="round"
          >
            <path d="M6 9l6 6 6-6" />
          </svg>
        </button>
        <div id={bodyId} hidden={!open}>
          {open && (
            <>
              <Rows rows={rows} />
              {details}
            </>
          )}
        </div>
      </div>
    )

  return (
    <section className="bold-subagent-card" aria-label={`${name}’s subagents`}>
      <div className="bold-subagent-card-head">
        <span className="bold-subagent-card-title">{title}</span>
        {details}
      </div>
      <Rows rows={rows} />
    </section>
  )
}
