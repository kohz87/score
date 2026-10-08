import type { Approval } from '@score/contract'
import { useEffect, useMemo, useState } from 'react'
import { Link, useParams, useSearchParams } from 'react-router'
import { AgentGlyph } from '../../components/AgentGlyph.tsx'
import { ApiError } from '../../data/api.ts'
import { copyText } from '../../data/clipboard.ts'
import { useStreamQuery } from '../../data/query-client.ts'
import { approvalsQuery } from '../chat/queries.ts'
import { ScrubTimeline } from './ScrubTimeline.tsx'
import { OtherScreens, WhatTheyAreDoing } from './SidePanels.tsx'
import { WatchStage } from './WatchStage.tsx'
import { useAgentPause, useWatchOverview, watchQuery } from './watch-queries.ts'
import {
  activityItems,
  backFrom,
  resumeCommand,
  stageAt,
  terminalHistory,
  type ActivityItem,
} from './watch-model.ts'
import './watch.css'

const PLAY_MS = 1000

function pendingApproval(approvals: Approval[], agentId: string): Approval | null {
  const open = approvals.filter(
    (item) =>
      item.agentId === agentId && item.status === 'pending' && item.phase !== 'guardian_evaluating',
  )
  return open.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null
}

export function WatchPage() {
  const { agentId = '' } = useParams()
  // A new agent starts a new replay.
  return <WatchView key={agentId} agentId={agentId} />
}

function WatchView({ agentId }: { agentId: string }) {
  const watch = useStreamQuery(watchQuery(agentId))
  const approvals = useStreamQuery(approvalsQuery)
  const overview = useWatchOverview()
  const pause = useAgentPause(agentId)
  const [cursor, setCursor] = useState<number | null>(null)
  const [playing, setPlaying] = useState(false)
  const [terminal, setTerminal] = useState<{ command: string; copied: boolean } | null>(null)
  // ?from=<seq> (History's "Replay in Watch") opens the replay at that moment, once the markers load.
  const [params] = useSearchParams()
  const from = /^\d{1,12}$/.test(params.get('from') ?? '') ? Number(params.get('from')) : null
  const [fromApplied, setFromApplied] = useState(from === null)

  const data = watch.data
  const markers = useMemo(() => data?.markers ?? [], [data?.markers])
  const frames = useMemo(() => data?.frames ?? [], [data?.frames])
  const marker = cursor === null ? null : (markers[Math.min(cursor, markers.length - 1)] ?? null)
  const seq = marker?.seq ?? null
  if (!fromApplied && from !== null && markers.length > 0) {
    setFromApplied(true)
    const index = markers.findIndex((candidate) => candidate.seq >= from)
    setCursor(index >= 0 ? index : markers.length - 1)
  }

  useEffect(() => {
    if (cursor === null || !playing) return
    const timer = setInterval(() => {
      setCursor((current) => {
        if (current === null) return null
        if (current + 1 >= markers.length) {
          setPlaying(false)
          return null
        }
        return current + 1
      })
    }, PLAY_MS)
    return () => clearInterval(timer)
  }, [cursor, playing, markers.length])

  const stage = useMemo(() => stageAt(frames, seq), [frames, seq])
  const mine = useMemo(
    () => (approvals.data ?? []).filter((item) => item.agentId === agentId),
    [approvals.data, agentId],
  )
  const items = useMemo(() => activityItems(frames, mine), [frames, mine])

  if (!data) {
    const missing = watch.error instanceof ApiError && watch.error.status === 404
    return (
      <div className="watch-page">
        {watch.status === 'error' ? (
          <p className="watch-state" role="alert">
            {missing ? 'That agent does not exist.' : 'Could not load this screen.'}{' '}
            <Link to="/now">Back to the run</Link>
          </p>
        ) : (
          <p className="watch-state" role="status">
            Loading the screen…
          </p>
        )}
      </div>
    )
  }

  const { agent } = data
  const paused = agent.status === 'paused'
  const live = cursor === null
  const currentKey = live
    ? (items[0]?.key ?? null)
    : marker?.kind === 'asked'
      ? (items.find((item) => item.kind === 'asked' && item.at === marker.at)?.key ?? null)
      : stage.front
        ? `frame-${stage.front.seq}`
        : null

  function select(index: number) {
    setPlaying(false)
    setCursor(index)
  }
  function goLive() {
    setPlaying(false)
    setCursor(null)
  }
  function toggle() {
    if (cursor === null) {
      // Freeze on the newest moment; the agent keeps working.
      if (markers.length > 0) {
        setCursor(markers.length - 1)
        setPlaying(false)
      }
    } else setPlaying(!playing)
  }
  function selectItem(item: ActivityItem) {
    const index = markers.findIndex((candidate) =>
      item.kind === 'asked'
        ? candidate.kind === 'asked' && candidate.at === item.at
        : candidate.seq === item.seq && candidate.kind !== 'asked',
    )
    const fallback = markers.findIndex((candidate) => candidate.seq === item.seq)
    const found = index >= 0 ? index : fallback
    if (found >= 0) select(found)
  }
  async function openInTerminal() {
    const command = resumeCommand(agent.id, data?.sessionId ?? null)
    setTerminal({ command, copied: await copyText(command) })
  }

  return (
    <div className="watch-page">
      <section className="watch-hero">
        <div className="watch-hero__who">
          <AgentGlyph agent={agent} size="lg" decorative />
          <div className="watch-hero__title">
            <Link to="/now/flow" className="watch-hero__back">
              Back to the run
            </Link>
            <h1>Watching {agent.name}</h1>
          </div>
        </div>
        <div className="watch-hero__actions">
          <button
            type="button"
            className="watch-button watch-button--outline"
            disabled={pause.isPending}
            onClick={() => pause.mutate(paused ? 'resume' : 'pause')}
          >
            {paused ? `Resume ${agent.name}` : `Pause ${agent.name}`}
          </button>
          <button
            type="button"
            className="watch-button watch-button--solid"
            onClick={() => void openInTerminal()}
          >
            <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
              <path
                d="M2.5 4 L6.5 8 L2.5 12 M8 12.5 H13.5"
                stroke="currentColor"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
            Open in terminal
          </button>
        </div>
      </section>
      {pause.isError && (
        <p className="watch-state" role="alert">
          Could not {paused ? 'resume' : 'pause'} {agent.name}. Please try again.
        </p>
      )}
      {terminal && (
        <p className="watch-state watch-state--command" role="status">
          {terminal.copied
            ? 'Copied. Paste this in a terminal:'
            : 'Select the command and press Ctrl+C, then run it in a terminal:'}{' '}
          <code>{terminal.command}</code>
        </p>
      )}
      <div className="watch-layout">
        <div className="watch-main">
          <WatchStage
            agent={agent}
            bySurface={stage.bySurface}
            front={stage.front}
            replayAt={marker?.at ?? null}
            approval={pendingApproval(mine, agentId)}
            history={
              stage.bySurface.terminal ? terminalHistory(frames, stage.bySurface.terminal.seq) : []
            }
            live={data.live}
          />
          <ScrubTimeline
            agent={agent}
            markers={markers}
            cursor={cursor === null ? null : Math.min(cursor, markers.length - 1)}
            playing={playing}
            onSelect={select}
            onLive={goLive}
            onBack={() => {
              const target = backFrom(markers, cursor)
              if (target !== null) select(target)
            }}
            onTogglePlay={toggle}
          />
        </div>
        <aside className="watch-side" aria-label={`What ${agent.name} is doing`}>
          <WhatTheyAreDoing
            agent={agent}
            items={items}
            currentKey={currentKey}
            live={live}
            onSelect={selectItem}
          />
          <OtherScreens items={overview.items} currentAgentId={agentId} failed={overview.isError} />
          <p className="watch-note">
            Pausing {agent.name} stops new work after the current step; Open in terminal lets you
            continue the same session yourself.
          </p>
        </aside>
      </div>
    </div>
  )
}
