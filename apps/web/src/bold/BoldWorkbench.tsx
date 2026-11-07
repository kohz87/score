import type { AgentSummary, Workbench } from '@score/contract'
import { useMemo, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { useSearchParams } from 'react-router'
import { useStreamQuery } from '../data/query-client.ts'
import '../routes/watch/watch.css'
import { agentDisplayName } from './bold-agents.ts'
import { CodeView } from './BoldWorkbenchCodeView.tsx'
import { DraftView } from './BoldWorkbenchDraftView.tsx'
import { LooseComments } from './BoldWorkbenchLooseComments.tsx'
import { ScreenView } from './BoldWorkbenchScreenView.tsx'
import { TabDot } from './BoldWorkbenchTabDot.tsx'
import { fileAgent, party, type BenchTab, type JobFace } from './bold-workbench-model.ts'
import { useBoldWorkbench } from './bold-workbench-queries.ts'
import { teamRoomQuery } from './room/room-queries.ts'
import './bold-workbench.css'

export type { JobFace } from './bold-workbench-model.ts'

export function BoldWorkbenchView({
  job,
  workbench,
  agents,
  work,
  preferredFile = null,
  hidden = false,
  pending = false,
  failed = false,
  onRetry,
  onWorkChange,
}: {
  job: JobFace | null
  workbench: Workbench | undefined
  agents: AgentSummary[]
  work: string | null
  preferredFile?: string | null
  hidden?: boolean
  pending?: boolean
  failed?: boolean
  onRetry?: () => void
  onWorkChange?: (tab: BenchTab) => void
}) {
  const byId = useMemo(() => new Map(agents.map((agent) => [agent.id, agent])), [agents])
  const jobKey = job?.id ?? null
  // Remember the pick with its job: another job starts on its first tab without a reset effect.
  const [picked, setPicked] = useState<{ job: string | null; key: string } | null>(null)
  const pickedKey = picked?.job === jobKey ? picked.key : null
  const tabRefs = useRef(new Map<string, HTMLButtonElement>())

  if (pending && !workbench)
    return (
      <div className="sidebody bold-workbench" hidden={hidden} data-testid="bold-workbench">
        <p className="bold-bench-state" role="status">
          Loading the Workbench…
        </p>
      </div>
    )
  if (failed && !workbench)
    return (
      <div className="sidebody bold-workbench" hidden={hidden} data-testid="bold-workbench">
        <div className="bold-bench-error" role="alert">
          <p>Couldn’t load the Workbench. Try again.</p>
          {onRetry && (
            <button type="button" className="btn sm" onClick={onRetry}>
              Retry
            </button>
          )}
        </div>
      </div>
    )
  if (!job)
    return (
      <div className="sidebody bold-workbench" hidden={hidden} data-testid="bold-workbench">
        <p className="bold-bench-state">Pick a job in the room to see its Workbench.</p>
      </div>
    )
  if (!workbench)
    return (
      <div className="sidebody bold-workbench" hidden={hidden} data-testid="bold-workbench">
        <p className="bold-bench-state" role="status">
          Loading the Workbench…
        </p>
      </div>
    )

  const tabs: { key: string; tab: BenchTab; label: string; agentId?: string }[] = [
    ...workbench.files.map((file) => ({
      key: `code:${file.path}`,
      tab: 'code' as const,
      label: file.path,
      agentId: fileAgent(file),
    })),
    ...workbench.screens.map((screen) => ({
      // Keyed by the agent, not the frame: a new frame must not remount the tab and drop its focus.
      key: `screen:${screen.frame.agentId}`,
      tab: 'screen' as const,
      label: `${
        byId.get(screen.frame.agentId)
          ? agentDisplayName(byId.get(screen.frame.agentId)!)
          : screen.frame.agentId
      }’s screen`,
      agentId: screen.frame.agentId,
    })),
    ...workbench.drafts.map((draft) => ({
      key: `draft:${draft.id}`,
      tab: 'draft' as const,
      label: draft.title,
      agentId: draft.agentId,
    })),
  ]
  const group: BenchTab = work === 'screen' ? 'screen' : work === 'draft' ? 'draft' : 'code'
  const inGroup = tabs.filter((tab) => tab.tab === group)
  const preferred = preferredFile
    ? inGroup.find((tab) => tab.tab === 'code' && tab.label === preferredFile)
    : undefined
  const active = inGroup.find((tab) => tab.key === pickedKey) ?? preferred ?? inGroup[0] ?? null
  const live = workbench.screens.some((screen) => screen.live) || job.state === 'working'
  const choose = (tab: { key: string; tab: BenchTab }) => {
    setPicked({ job: jobKey, key: tab.key })
    onWorkChange?.(tab.tab)
  }
  const focusKey = active?.key ?? tabs[0]?.key ?? null
  const onTabsKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const moves: Record<string, number | 'first' | 'last'> = {
      ArrowRight: 1,
      ArrowDown: 1,
      ArrowLeft: -1,
      ArrowUp: -1,
      Home: 'first',
      End: 'last',
    }
    const move = moves[event.key]
    if (move === undefined || tabs.length === 0) return
    event.preventDefault()
    const focused = (event.target as Element).closest<HTMLElement>('[data-bench-tab]')?.dataset
      .benchTab
    const from = Math.max(
      0,
      tabs.findIndex((tab) => tab.key === (focused ?? focusKey)),
    )
    const next =
      move === 'first'
        ? 0
        : move === 'last'
          ? tabs.length - 1
          : (from + move + tabs.length) % tabs.length
    const target = tabs[next]
    if (!target) return
    choose(target)
    requestAnimationFrame(() => tabRefs.current.get(target.key)?.focus())
  }

  let body: ReactNode
  if (!active)
    body = (
      <p className="bold-bench-state">
        Nothing to show in this job’s Workbench yet. Results appear as the team edits and reviews.
      </p>
    )
  else if (active.tab === 'code') {
    const file = workbench.files.find((item) => `code:${item.path}` === active.key)!
    body = (
      <>
        <CodeView file={file} agents={byId} />
        <LooseComments comments={workbench.looseComments} agents={byId} />
      </>
    )
  } else if (active.tab === 'screen') {
    const screen = workbench.screens.find((item) => `screen:${item.frame.agentId}` === active.key)!
    body = <ScreenView screen={screen} agent={byId.get(screen.frame.agentId)} />
  } else {
    const draft = workbench.drafts.find((item) => `draft:${item.id}` === active.key)!
    body = <DraftView draft={draft} agent={byId.get(draft.agentId)} />
  }

  return (
    <div className="sidebody bold-workbench" hidden={hidden} data-testid="bold-workbench">
      <header className="bold-bench-head">
        <div>
          <span className="bold-bench-kicker">Workbench</span>
          <h2>{job.title}</h2>
        </div>
        <span className={`bold-bench-status${live ? ' is-live' : ''}`}>
          <span className={`bold-bench-dot${live ? ' livedot' : ''}`} aria-hidden="true" />
          {live ? 'Live' : 'Read-only'}
        </span>
      </header>
      {tabs.length > 0 && (
        <div
          className="bold-bench-tabs"
          role="group"
          aria-label="Workbench files and screens"
          onKeyDown={onTabsKeyDown}
        >
          {tabs.map((tab) => (
            <button
              key={tab.key}
              ref={(element) => {
                if (element) tabRefs.current.set(tab.key, element)
                else tabRefs.current.delete(tab.key)
              }}
              type="button"
              className={`chip bold-bench-tab${active?.key === tab.key ? ' on' : ''}`}
              aria-pressed={active?.key === tab.key}
              data-bench-tab={tab.key}
              tabIndex={tab.key === focusKey ? 0 : -1}
              onClick={() => choose(tab)}
            >
              <TabDot agent={party(byId, tab.agentId)} />
              <span>{tab.label}</span>
            </button>
          ))}
        </div>
      )}
      {failed && (
        <div className="bold-bench-inline-error" role="alert">
          <span>Some of the Workbench couldn’t be refreshed.</span>
          {onRetry && (
            <button type="button" className="btn sm" onClick={onRetry}>
              Retry
            </button>
          )}
        </div>
      )}
      {body}
    </div>
  )
}

export function BoldWorkbench({
  agents,
  hidden,
  fallbackJob,
}: {
  agents: AgentSummary[]
  hidden: boolean
  /** The topic's face when the team room doesn't list it (a one-to-one's chat). */
  fallbackJob?: JobFace | undefined
}) {
  const [search, setSearchParams] = useSearchParams()
  const room = useStreamQuery(teamRoomQuery(null))
  const jobs = room.data?.jobs ?? []
  const selectedId = search.get('job')
  const named = selectedId ? jobs.find((item) => item.id === selectedId) : undefined
  const job = named ?? (selectedId ? null : jobs.find((item) => item.state !== 'closed'))
  // The room list leaves closed jobs out. Their Workbench is still readable by id, so show it with a neutral heading
  // until a `job.upserted` event supplies the real title.
  const jobFace: JobFace | null =
    job ??
    (selectedId
      ? fallbackJob?.id === selectedId
        ? fallbackJob
        : { id: selectedId, title: 'Closed job', state: 'closed' }
      : null)
  const work = search.get('work')
  const data = useBoldWorkbench(
    jobFace?.id ?? null,
    !hidden,
    job?.activeAgents ?? [],
    work === 'screen',
  )
  const choose = (tab: BenchTab) => {
    const params = new URLSearchParams(search)
    params.set('work', tab)
    params.delete('file')
    setSearchParams(params)
  }
  return (
    <BoldWorkbenchView
      job={jobFace}
      workbench={data.workbench}
      agents={agents}
      work={work}
      preferredFile={search.get('file')}
      hidden={hidden}
      pending={data.pending || (room.status === 'pending' && !selectedId)}
      failed={data.failed || room.status === 'error'}
      onRetry={data.retry}
      onWorkChange={choose}
    />
  )
}
