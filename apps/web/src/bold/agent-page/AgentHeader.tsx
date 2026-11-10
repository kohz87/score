import type { AgentDetail, AgentSummary } from '@score/contract'
import { Link, useLocation } from 'react-router'
import { AgentGlyph } from '../../components/AgentGlyph.tsx'
import { runtimeLabel } from '../../components/runtime-label.ts'
import { agentDisplayName, agentMood, agentStateLabel, canTalkTo } from '../bold-agents.ts'
import { boldAgentScreenLink } from '../bold-links.ts'
import { AgentMoreMenu } from './AgentMoreMenu.tsx'

/** Header (mock-up 26): look, name, role, Edit; one status line; Message, Pause and the ⋯ menu. */
export function AgentHeader({
  agent,
  agents,
  summary,
  waiting,
  editing,
  canEdit,
  inFlight,
  failed,
  pausePending,
  terminalOffered,
  canRemove,
  onEdit,
  onPause,
  onRemove,
}: {
  agent: AgentDetail
  agents: AgentSummary[]
  summary: AgentSummary | undefined
  waiting: boolean
  editing: boolean
  canEdit: boolean
  inFlight: boolean
  /** The pause action that failed last, so the button can repeat it. */
  failed: 'pause' | 'resume' | null | undefined
  pausePending: boolean
  terminalOffered: boolean
  canRemove: boolean
  onEdit: () => void
  onPause: () => void
  onRemove: () => void
}) {
  const location = useLocation()
  const name = agentDisplayName(agent)
  const manager = agents.find((item) => item.id === agent.reportsTo)
  const paused = agent.status === 'paused'
  const engine = runtimeLabel(agent.runtime) ?? 'Hermes'
  const screen = agent.served && (!agent.runtime || agent.runtime === 'hermes')
  const pauseLabel = failed
    ? `${failed === 'pause' ? 'Pause' : 'Resume'} again`
    : paused
      ? 'Resume'
      : 'Pause'
  const showPause = !inFlight && agent.lifecycle?.state !== 'removed'
  return (
    <div className="pagehead bold-agent-head" id="agent-overview">
      <Link className="link bold-agent-back" to="/b/agents" aria-label="Back to agents">
        Agents
      </Link>
      <span className="muted bold-agent-slash" aria-hidden>
        /
      </span>
      <AgentGlyph agent={agent} size="md" decorative lively mood={agentMood(agent)} />
      <div className="bold-agent-who">
        <div className="bold-agent-namerow">
          <h1 className="big" id="agent-title">
            {name}
          </h1>
          <span className="muted bold-agent-role">{agent.role}</span>
          {canEdit && (
            <button
              type="button"
              className="btn sm bold-agent-edit-btn"
              aria-label="Change name, role and look"
              aria-expanded={editing}
              onClick={onEdit}
            >
              Edit
            </button>
          )}
        </div>
        <div className="bold-agent-line">
          <span aria-live="polite" className="bold-agent-state">
            <span>{engine}</span>
            {' · '}
            {manager ? (
              <>
                reports to{' '}
                <Link to={`/b/agents/${encodeURIComponent(manager.id)}`}>{manager.name}</Link>
              </>
            ) : (
              <>reports to {agent.reportsTo ?? 'no one'}</>
            )}
            {' · '}
            {waiting ? (
              <Link className="link" to="/b">
                {agentStateLabel({ ...agent, status: 'waiting' })}
                {agent.activity ? ` · ${agent.activity}` : ''}
              </Link>
            ) : (
              <>
                {agentStateLabel(agent)}
                {agent.activity && agent.status === 'working' ? ` · ${agent.activity}` : ''}
              </>
            )}
          </span>
          {summary?.runtimeNote && <span className="small muted">{summary.runtimeNote}</span>}
        </div>
      </div>
      <span className="row wrap bold-agent-actions">
        {canTalkTo(agent) && (
          <Link className="btn primary" to={`/b?with=${encodeURIComponent(agent.id)}`}>
            Message
          </Link>
        )}
        {showPause && (
          <button
            type="button"
            className="btn ghost"
            aria-label={`${pauseLabel} ${name}`}
            disabled={pausePending}
            onClick={onPause}
          >
            {pauseLabel}
          </button>
        )}
        {(screen || (terminalOffered && canTalkTo(agent)) || canRemove) && (
          <AgentMoreMenu>
            {(close) => (
              <>
                {screen && (
                  <Link
                    role="menuitem"
                    className="bold-agent-watch"
                    to={boldAgentScreenLink(agent.id)}
                    onClick={close}
                  >
                    Look at its screen
                  </Link>
                )}
                {/* 3.11.0 (owner): the agent's own CLI in Score's Terminal (same password/passkey lock). */}
                {terminalOffered && canTalkTo(agent) && (
                  <Link
                    role="menuitem"
                    to={`/b/terminal?agent=${encodeURIComponent(agent.id)}`}
                    state={{ terminalFrom: `${location.pathname}${location.search}` }}
                    onClick={close}
                  >
                    Open live session
                  </Link>
                )}
                {canRemove && (
                  <button
                    type="button"
                    role="menuitem"
                    className="bold-agent-remove"
                    onClick={() => {
                      close()
                      onRemove()
                    }}
                  >
                    Remove {name}
                  </button>
                )}
              </>
            )}
          </AgentMoreMenu>
        )}
      </span>
    </div>
  )
}
