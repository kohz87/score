import type { AgentDetail, AgentSummary } from '@score/contract'
import { useEffect, useRef, useState } from 'react'
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router'
import { useQueryClient } from '@tanstack/react-query'
import { AgentGlyph } from '../components/AgentGlyph.tsx'
import { runtimeLabel } from '../components/runtime-label.ts'
import { useStreamQuery } from '../data/query-client.ts'
import { agentsQuery, approvalsQuery } from '../routes/chat/queries.ts'
import { usePermissionAction } from '../routes/settings/rules-queries.ts'
import { useAgentDetail } from '../routes/team/team-queries.ts'
import { AgentFiles } from '../routes/team/AgentFiles.tsx'
import { CodingOverview } from '../routes/team/CodingAgent.tsx'
import { ModelTab } from '../routes/team/ModelTab.tsx'
import { boldAgentScreenLink } from './bold-links.ts'
import { useTerminalAvailable } from '../shell/TerminalButton.tsx'
import type { AgentFileName } from '../routes/team/file-queries.ts'
import { useAgentPause } from '../routes/watch/watch-queries.ts'
import { agentDisplayName, agentMood, agentStateLabel, canTalkTo } from './bold-agents.ts'
import { pairingProblem } from './bold-errors.ts'
import { questionNeedsYou, questionsQuery } from '../data/question-queries.ts'
import { approvalNeedsYou } from './room/room-model.ts'
import '../routes/team/team.css'
import '../components/todo.css'
import { BoldAgentStatus } from './BoldAgentOperation.tsx'
import { BoldAgentMore } from './BoldAgentMore.tsx'
import { BoldRemoveAgent } from './BoldRemoveAgent.tsx'
import { RunsOnCard } from './BoldRunsOn.tsx'
import './bold-team.css'

/** "Change permissions" on the Asks card goes to the Never rules card under More. */
const permissionsSection = 'agent-permissions'

/** The four cards the prototype puts first: how it works, what runs it, where, and what it asks first. */
function HermesUpFront({
  agent,
  file,
  onFile,
  openSection,
}: {
  agent: AgentDetail
  file: AgentFileName
  onFile: (file: AgentFileName) => void
  openSection: (id: string) => void
}) {
  const engine = runtimeLabel(agent.runtime) ?? 'Hermes'
  const change = usePermissionAction(agent.id)
  const asks = agent.permissions.filter((permission) => permission.level === 'asks')
  return (
    <div className="grid2 bold-upfront">
      <section className="card bold-up-card" id="agent-personality" aria-label="How it works">
        <span className="lab">How {agentDisplayName(agent)} works</span>
        <AgentFiles agent={agent} file={file} onFile={onFile} />
      </section>

      <section className="card bold-up-card" id="agent-model" aria-labelledby="agent-model-title">
        <span className="lab" id="agent-model-title">
          Runs on
        </span>
        <span className="row wrap">
          <span className="chip on">{engine}</span>
          <span className="small muted">Engine is set when the agent is added.</span>
        </span>
        <ModelTab agent={agent} />
      </section>

      <RunsOnCard agent={agent} />

      <section
        className="card bold-up-card"
        id="agent-asks"
        aria-labelledby="agent-asks-title"
        data-protected="block"
      >
        <span className="lab" id="agent-asks-title">
          Asks you first before
        </span>
        {asks.length ? (
          <ul className="bold-asks">
            {asks.map((permission) => (
              <li key={permission.id} style={{ listStyle: 'none' }}>
                <label className="check">
                  <input
                    type="checkbox"
                    checked
                    disabled={change.isPending}
                    onChange={(event) =>
                      change.mutate({
                        id: permission.id,
                        level: event.target.checked ? 'asks' : 'allowed',
                      })
                    }
                  />
                  <span className="grow">{permission.label}</span>
                </label>
              </li>
            ))}
          </ul>
        ) : (
          <p className="small muted">Nothing asks you first right now.</p>
        )}
        {change.isError && <p role="alert">Couldn’t change the permission. Try again.</p>}
        <p className="small muted">
          Stricter than the team rules is fine; looser isn’t.{' '}
          <button type="button" className="link" onClick={() => openSection(permissionsSection)}>
            Change permissions
          </button>
        </p>
      </section>
    </div>
  )
}

/** The two overview facts the prototype puts in a quiet row under the agent's state. */
function OverviewFacts({ agent, agents }: { agent: AgentDetail; agents: AgentSummary[] }) {
  const manager = agents.find((item) => item.id === agent.reportsTo)
  return (
    <dl className="bold-agent-facts" aria-label="Overview facts">
      <div>
        <dt>Reports to</dt>
        <dd>
          {manager ? (
            <Link to={`/b/team/${encodeURIComponent(manager.id)}`}>{manager.name}</Link>
          ) : (
            (agent.reportsTo ?? 'No one')
          )}
        </dd>
      </div>
      <div>
        <dt>Works in</dt>
        <dd>{agent.worksIn ? <code>{agent.worksIn}</code> : 'Not set'}</dd>
      </div>
    </dl>
  )
}

/** PLAN 11.8b: one agent on the bold shell. The four cards come first; every classic tab lives under More. */
export function BoldAgentPage() {
  const { agentId = '' } = useParams()
  return <AgentProfile key={agentId} agentId={agentId} />
}

function AgentProfile({ agentId }: { agentId: string }) {
  const detail = useAgentDetail(agentId)
  const agents = useStreamQuery(agentsQuery)
  const approvals = useStreamQuery(approvalsQuery).data ?? []
  const questions = useStreamQuery(questionsQuery).data ?? []
  const location = useLocation()
  const [search] = useSearchParams()
  // 3.11.0: "Open live session" exists only when the server offers a terminal.
  const terminalOffered = useTerminalAvailable()
  const [file, setFile] = useState<AgentFileName>('SOUL.md')
  const [more, setMore] = useState(() => location.hash.startsWith('#agent-') || search.has('path'))
  const client = useQueryClient()
  const pause = useAgentPause(agentId)
  const [removing, setRemoving] = useState(false)
  const navigate = useNavigate()
  // A removal can show as `removed` in the list before the operation card reads `completed`: leave either way.
  const lifeState = (agents.data?.find((agent) => agent.id === agentId) ?? detail.data)?.lifecycle
    ?.state
  // Only a removal this page watched happens leaves: a removed agent's page stays reachable (history, links).
  const previousLife = useRef(lifeState)
  useEffect(() => {
    const before = previousLife.current
    previousLife.current = lifeState
    if (
      lifeState === 'removed' &&
      (before === 'deleting' || before === 'needs_attention' || removing)
    )
      void navigate('/b/team')
  }, [lifeState, navigate, removing])

  if (!detail.data && detail.isPending) return <p role="status">Loading agent…</p>
  if (!detail.data && detail.isError)
    return (
      <section className="page bold-agent-missing" role="alert">
        <h1 className="big">Agent unavailable</h1>
        <p className="muted">Couldn’t load this agent. Check the address or try again.</p>
        <button type="button" className="btn" onClick={() => void detail.refetch()}>
          Try again
        </button>
      </section>
    )
  if (!detail.data) return null

  const summary = agents.data?.find((agent) => agent.id === agentId)
  // The detail endpoint has no watermark; the fenced list owns live summary fields.
  const agent: AgentDetail = {
    ...detail.data,
    ...summary,
    model:
      summary && summary.model?.id !== detail.data.model?.id
        ? summary.model && { ...summary.model, via: '', fallback: null }
        : detail.data.model,
  }
  const coding = Boolean(agent.runtime && agent.runtime !== 'hermes')
  const paused = agent.status === 'paused'
  // The server can commit a pause and still answer with an error. While that error shows, the button repeats the
  // action that failed, whatever the status says now (the classic header's rule).
  const failed = pause.isError ? pause.variables : null
  const needsYou =
    approvals.some((approval) => approval.agentId === agent.id && approvalNeedsYou(approval)) ||
    questions.some((question) => question.agentId === agent.id && questionNeedsYou(question))
  const inFlight =
    agent.lifecycle?.state === 'setting_up' ||
    agent.lifecycle?.state === 'needs_attention' ||
    agent.lifecycle?.state === 'deleting'
  const waiting = needsYou || agent.status === 'waiting'

  function reveal(id: string) {
    setMore(true)
    window.setTimeout(() => {
      document.getElementById(id)?.scrollIntoView({ block: 'start' })
    }, 0)
  }

  function openRemove() {
    setRemoving(true)
    window.setTimeout(
      () => document.querySelector('.bold-remove-agent')?.scrollIntoView({ block: 'center' }),
      0,
    )
  }

  function togglePause() {
    pause.mutate(failed ?? (paused ? 'resume' : 'pause'), {
      onSettled: () => {
        void client.invalidateQueries({ queryKey: ['team'] })
        void client.invalidateQueries({ queryKey: ['chat', 'agents'] })
      },
    })
  }

  return (
    <section className="page bold-agent" aria-labelledby="agent-title">
      <div className="pagehead" id="agent-overview">
        <Link className="link" to="/b/team">
          Team
        </Link>
        <span className="muted" aria-hidden>
          /
        </span>
        <AgentGlyph agent={agent} size="md" decorative lively mood={agentMood(agent)} />
        <h1 className="big" id="agent-title">
          {agentDisplayName(agent)}
        </h1>
        <span className="muted bold-agent-role">{agent.role}</span>
        <span className="row wrap bold-agent-actions">
          {canTalkTo(agent) && (
            <Link className="btn primary" to={`/b?with=${encodeURIComponent(agent.id)}`}>
              Message
            </Link>
          )}
          {/* 3.11.0 (owner): the agent's own CLI in Score's Terminal (same password/passkey lock). */}
          {terminalOffered && canTalkTo(agent) && (
            <Link
              className="btn ghost"
              to={`/b/terminal?agent=${encodeURIComponent(agent.id)}`}
              state={{ terminalFrom: `${location.pathname}${location.search}` }}
            >
              Open live session
            </Link>
          )}
          {!inFlight && agent.lifecycle?.state !== 'removed' && (
            <button
              type="button"
              className="btn ghost"
              disabled={pause.isPending}
              onClick={togglePause}
            >
              {failed
                ? `${failed === 'pause' ? 'Pause' : 'Resume'} again`
                : paused
                  ? 'Resume'
                  : 'Pause'}{' '}
              {agentDisplayName(agent)}
            </button>
          )}
          {agent.lifecycle?.state !== 'removed' &&
            agent.lifecycle?.state !== 'setting_up' &&
            agent.lifecycle?.state !== 'deleting' &&
            agent.id !== 'default' && (
              <button
                type="button"
                className="link bold-agent-remove"
                id="agent-remove-open"
                aria-expanded={removing}
                onClick={() => setRemoving(true)}
              >
                Remove agent…
              </button>
            )}
          {/* 3.12.1: a Hermes agent's Bot Desktop; coding agents have no screen to show. */}
          {agent.served && (!agent.runtime || agent.runtime === 'hermes') && (
            <>
              <Link className="link bold-agent-watch" to={boldAgentScreenLink(agent.id)}>
                Look at its screen
              </Link>
            </>
          )}
        </span>
      </div>
      {inFlight && agent.lifecycle && (
        <BoldAgentStatus name={agentDisplayName(agent)} lifecycle={agent.lifecycle} />
      )}
      {removing && agent.id !== 'default' && (
        <BoldRemoveAgent
          lifecycle={agent.lifecycle}
          agentId={agent.id}
          name={agentDisplayName(agent)}
          coding={coding}
          onClose={() => {
            setRemoving(false)
            window.setTimeout(() => document.getElementById('agent-remove-open')?.focus(), 0)
          }}
        />
      )}
      <div className="row wrap bold-agent-now">
        <span className="bold-agent-state" aria-live="polite">
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
        {/* On the same row as the state (the prototype's agent page), so "needs you" is never alone on a line. */}
        {!coding && <OverviewFacts agent={agent} agents={agents.data ?? []} />}
      </div>
      {pause.error && (
        <p role="alert" className="bold-team-error">
          {pairingProblem(pause.error) ??
            `Couldn’t ${paused ? 'resume' : 'pause'} ${agentDisplayName(agent)}. Try again.`}
        </p>
      )}
      {detail.isError && (
        <p role="alert">
          Couldn’t refresh agent details.{' '}
          <button type="button" className="link" onClick={() => void detail.refetch()}>
            Try again
          </button>
        </p>
      )}

      {coding ? (
        <div className="bold-coding">
          <CodingOverview agent={agent} teamPath="/b/team" />
        </div>
      ) : (
        <HermesUpFront agent={agent} file={file} onFile={setFile} openSection={reveal} />
      )}

      <button
        type="button"
        className="btn ghost bold-more-toggle"
        aria-expanded={more}
        aria-controls="agent-more"
        onClick={() => setMore((open) => !open)}
      >
        {more
          ? 'Less'
          : `More: ${
              coding
                ? 'tools, workspace, delete'
                : 'memory, skills, tools, workspace, repeating jobs, delete'
            }`}
      </button>

      {more && (
        <div className="bold-more" id="agent-more">
          <BoldAgentMore
            agent={agent}
            coding={coding}
            initialPath={search.get('path')}
            onDelete={openRemove}
          />
        </div>
      )}
    </section>
  )
}
