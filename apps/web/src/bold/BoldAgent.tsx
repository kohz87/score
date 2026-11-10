import type { AgentDetail } from '@score/contract'
import { useEffect, useRef, useState } from 'react'
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router'
import { useQueryClient } from '@tanstack/react-query'
import { useStreamQuery } from '../data/query-client.ts'
import { agentsQuery, approvalsQuery } from '../routes/chat/queries.ts'
import { useAgentDetail } from '../routes/team/team-queries.ts'
import { useTerminalAvailable } from '../shell/TerminalButton.tsx'
import { useAgentPause } from '../routes/watch/watch-queries.ts'
import { agentDisplayName } from './bold-agents.ts'
import { pairingProblem } from './bold-errors.ts'
import { questionNeedsYou, questionsQuery } from '../data/question-queries.ts'
import { approvalNeedsYou } from './room/room-model.ts'
import '../routes/team/team.css'
import { BoldAgentStatus } from './BoldAgentOperation.tsx'
import { BoldRemoveAgent } from './BoldRemoveAgent.tsx'
import { AgentEditPanel } from './agent-page/AgentEditPanel.tsx'
import { AgentHeader } from './agent-page/AgentHeader.tsx'
import { AgentSectionMenu } from './agent-page/AgentSectionMenu.tsx'
import { hashTarget, scrollToTarget } from './agent-page/agent-sections.ts'
import { CodingSections } from './agent-page/CodingSections.tsx'
import { MemorySection } from './agent-page/MemorySection.tsx'
import { ModelSection } from './agent-page/ModelSection.tsx'
import { PersonalitySection } from './agent-page/PersonalitySection.tsx'
import { SafetySection } from './agent-page/SafetySection.tsx'
import { ToolsSection } from './agent-page/ToolsSection.tsx'
import { useAgentFiles } from './agent-page/use-agent-files.ts'
import { WorkSection } from './agent-page/WorkSection.tsx'
import './bold-team.css'
import './agent-more/agent-more.css'
import './agent-page/agent-page.css'

/** One agent on the bold shell (mock-up 26): the header, a section menu, and one column of sections. */
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
  const client = useQueryClient()
  const pause = useAgentPause(agentId)
  const [removing, setRemoving] = useState(false)
  const [editing, setEditing] = useState(false)
  // A workspace link opens the Files panel: on one file with `?path=`, at the root without it.
  const wantsFiles = ['#agent-workspace', '#agent-files'].includes(location.hash)
  const { files, close: dropFiles } = useAgentFiles(search.get('path') ?? (wantsFiles ? '' : null))
  const navigate = useNavigate()
  // Closing also clears the link from the address, so following the same link again reopens the panel.
  const closeFiles = () => {
    dropFiles()
    if (search.has('path') || wantsFiles)
      void navigate({ pathname: location.pathname, search: '', hash: '' }, { replace: true })
  }
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
      void navigate('/b/agents')
  }, [lifeState, navigate, removing])
  // A link to a card (`#agent-where`, `#agent-workspace`) scrolls once the sections are on the page.
  const ready = Boolean(detail.data)
  const target = hashTarget(location.hash)
  useEffect(() => {
    if (!ready || !target) return
    const timer = window.setTimeout(() => scrollToTarget(target.id), 0)
    return () => window.clearTimeout(timer)
  }, [ready, target?.id]) // eslint-disable-line react-hooks/exhaustive-deps -- the id is all that matters

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
  const canRemove =
    agent.lifecycle?.state !== 'removed' &&
    agent.lifecycle?.state !== 'setting_up' &&
    agent.lifecycle?.state !== 'deleting' &&
    agent.id !== 'default'
  const editable = !agent.lifecycle || agent.lifecycle.state === 'ready'

  function openRemove() {
    setRemoving(true)
    window.setTimeout(
      () => document.querySelector('.bold-remove-agent')?.scrollIntoView?.({ block: 'center' }),
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
      <AgentHeader
        agent={agent}
        agents={agents.data ?? []}
        summary={summary}
        waiting={waiting}
        editing={editing}
        canEdit
        inFlight={inFlight}
        failed={failed}
        pausePending={pause.isPending}
        terminalOffered={terminalOffered}
        canRemove={canRemove}
        onEdit={() => setEditing((open) => !open)}
        onPause={togglePause}
        onRemove={openRemove}
      />
      {editing && (
        <AgentEditPanel agent={agent} editable={editable} onClose={() => setEditing(false)} />
      )}
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

      <div className="bold-agent-body">
        <AgentSectionMenu
          coding={coding}
          name={agentDisplayName(agent)}
          canRemove={canRemove}
          removing={removing}
          onRemove={openRemove}
        />
        <div className="bold-agent-sections">
          {coding ? (
            <CodingSections
              agent={agent}
              files={files}
              onCloseFiles={closeFiles}
              initialOpen={target?.open}
            />
          ) : (
            <>
              <PersonalitySection agent={agent} />
              <ModelSection agent={agent} initialOpen={target?.open} />
              <SafetySection agent={agent} initialOpen={target?.open} />
              <ToolsSection agent={agent} coding={false} initialOpen={target?.open} />
              <MemorySection agent={agent} initialOpen={target?.open} />
              <WorkSection
                agent={agent}
                coding={false}
                files={files}
                onCloseFiles={closeFiles}
                initialOpen={target?.open}
              />
            </>
          )}
        </div>
      </div>
    </section>
  )
}
