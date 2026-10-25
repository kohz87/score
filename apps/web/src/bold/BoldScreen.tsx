import type { AgentSummary, Approval, WatchFrame, WatchMarker } from '@score/contract'
import { useEffect, useMemo, useState, type CSSProperties } from 'react'
import { Link, useParams } from 'react-router'
import { AgentGlyph } from '../components/AgentGlyph.tsx'
import { ApiError } from '../data/api.ts'
import { useStreamQuery } from '../data/query-client.ts'
import { useApprovalDecision } from '../routes/chat/ApprovalCard.tsx'
import { approvalsQuery } from '../routes/chat/queries.ts'
import { ScrubTimeline } from '../routes/watch/ScrubTimeline.tsx'
import { BrowserPane, EditorPane, TerminalPane } from '../routes/watch/WatchStage.tsx'
import '../routes/watch/watch.css'
import {
  pendingApprovalsQuery,
  useWatchLiveRefresh,
  watchQuery,
} from '../routes/watch/watch-queries.ts'
import {
  activityItems,
  backFrom,
  clock,
  clockSeconds,
  stageAt,
  surfaceLabels,
  terminalHistory,
  type ActivityItem,
  type Surface,
} from '../routes/watch/watch-model.ts'
import { agentDisplayName, agentStateLabel } from './bold-agents.ts'
import { approvalNeedsYou } from './room/room-model.ts'
import './bold-screen.css'

const surfaces: Surface[] = ['terminal', 'editor', 'browser']
const PLAY_MS = 1000

function pendingApproval(approvals: Approval[], agentId: string): Approval | null {
  const open = approvals.filter((item) => item.agentId === agentId && approvalNeedsYou(item))
  return open.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null
}

function ApprovalBar({ approval, agent }: { approval: Approval; agent: AgentSummary }) {
  const { busy, error, posted, decide } = useApprovalDecision(approval.id)
  const answered = posted !== null && posted.status !== 'pending'
  return (
    <div
      className="watch-approval bold-screen-approval"
      role="group"
      aria-label="Approval needed"
      data-protected="flex"
    >
      <span className="watch-approval__text">
        {agentDisplayName(agent)} stopped
        {approval.command ? (
          <>
            {' '}
            before <code>{approval.command}</code>
          </>
        ) : (
          <>: {approval.title}</>
        )}{' '}
        and is waiting for you
        {error && (
          <span className="watch-approval__error" role="alert">
            {' '}
            {error}
          </span>
        )}
        {answered && <span className="bold-screen-answer">Answer sent.</span>}
      </span>
      {approval.actionable && approval.choices.includes('once') && (
        <button
          type="button"
          className="watch-approval__go"
          disabled={busy || answered}
          onClick={() => void decide('once')}
        >
          Approve
        </button>
      )}
      {approval.actionable && approval.choices.includes('deny') && (
        <button
          type="button"
          className="watch-approval__no"
          disabled={busy || answered}
          onClick={() => void decide('deny')}
        >
          Deny
        </button>
      )}
      {!approval.actionable && (
        <Link className="watch-approval__link" to="/b">
          Answer in the team room
        </Link>
      )}
    </div>
  )
}

export function BoldScreenView({
  agent,
  frames,
  markers,
  approvals,
}: {
  agent: AgentSummary
  frames: WatchFrame[]
  markers: WatchMarker[]
  approvals: Approval[]
}) {
  const [selected, setSelected] = useState<WatchMarker | null>(null)
  const [playing, setPlaying] = useState(false)
  const [surface, setSurface] = useState<Surface | null>(null)
  const found = selected
    ? markers.findIndex(
        (marker) =>
          marker.seq === selected.seq && marker.at === selected.at && marker.kind === selected.kind,
      )
    : -1
  const cursor = selected === null || markers.length === 0 ? null : found >= 0 ? found : 0
  const marker = cursor === null ? null : (markers[cursor] ?? null)
  const seq = marker?.seq ?? null
  const live = cursor === null
  const stage = useMemo(() => stageAt(frames, seq), [frames, seq])
  const items = useMemo(() => activityItems(frames, approvals), [frames, approvals])
  const top = surface && stage.bySurface[surface] ? surface : (stage.front?.surface ?? null)
  const frame = top ? (stage.bySurface[top] ?? null) : null
  const currentKey = live
    ? (items[0]?.key ?? null)
    : marker?.kind === 'asked'
      ? (items.find((item) => item.kind === 'asked' && item.at === marker.at)?.key ?? null)
      : stage.front
        ? `frame-${stage.front.seq}`
        : null
  const waiting = pendingApproval(approvals, agent.id)
  const history = useMemo(
    () =>
      frame?.terminal
        ? terminalHistory(frames, frame.seq).flatMap((item) =>
            item.terminal ? [item.terminal] : [],
          )
        : [],
    [frame, frames],
  )

  useEffect(() => {
    if (!playing) return
    const timer = setInterval(() => {
      if (cursor === null) {
        setPlaying(false)
        return
      }
      if (cursor >= markers.length - 1) {
        setSelected(null)
        setPlaying(false)
      } else setSelected(markers[cursor + 1] ?? null)
    }, PLAY_MS)
    return () => clearInterval(timer)
  }, [cursor, markers, playing])

  const select = (index: number) => {
    setPlaying(false)
    setSelected(markers[index] ?? null)
  }
  const selectItem = (item: ActivityItem) => {
    const exact = markers.findIndex((candidate) =>
      item.kind === 'asked'
        ? candidate.kind === 'asked' && candidate.at === item.at
        : candidate.seq === item.seq && candidate.kind !== 'asked',
    )
    if (exact >= 0) return select(exact)
    // Approvals can predate the first marker Score kept. Pick the closest moment so the plain-step row still takes
    // the replay to the nearest thing that happened, rather than leaving a step that looks clickable but does nothing.
    if (markers.length === 0) return
    const at = Date.parse(item.at)
    let nearest = 0
    for (let index = 1; index < markers.length; index += 1) {
      if (
        Math.abs(Date.parse(markers[index]!.at) - at) <
        Math.abs(Date.parse(markers[nearest]!.at) - at)
      )
        nearest = index
    }
    select(nearest)
  }
  const itemIndex = (item: ActivityItem) =>
    markers.findIndex((candidate) =>
      item.kind === 'asked'
        ? candidate.kind === 'asked' && candidate.at === item.at
        : candidate.seq === item.seq && candidate.kind !== 'asked',
    )
  const chronological = [...items].reverse()

  return (
    <section className="page bold-screen" aria-labelledby="bold-screen-title">
      <div className="pagehead bold-screen-head">
        <Link className="link" to="/b">
          Team room
        </Link>
        <span className="muted">/</span>
        <AgentGlyph agent={agent} size="lg" decorative />
        <div className="bold-screen-title">
          <h1 id="bold-screen-title">{agentDisplayName(agent)}’s screen</h1>
          <span className="muted">{agentStateLabel(agent)}</span>
        </div>
        <Link className="btn ghost bold-screen-terminal" to="/terminal">
          Open in terminal
        </Link>
      </div>

      <div className="bold-screen-layout">
        <section className="bold-screen-log" aria-label={`What ${agentDisplayName(agent)} did`}>
          <h2 className="bold-screen-log-title">What {agentDisplayName(agent)} did</h2>
          {chronological.length === 0 && (
            <p className="bold-screen-empty">Nothing yet. Steps show up here as they happen.</p>
          )}
          <ol className="bold-screen-steps">
            {chronological.map((item, index) => {
              const target = itemIndex(item)
              const current = item.key === currentKey
              return (
                <li key={item.key}>
                  <button
                    type="button"
                    className={`bold-screen-step${current ? ' sel' : ''}`}
                    aria-current={current ? 'true' : undefined}
                    disabled={target < 0}
                    onClick={() => selectItem(item)}
                  >
                    <time className="mono bold-screen-time" dateTime={item.at}>
                      {live && index === chronological.length - 1 ? 'now' : clockSeconds(item.at)}
                    </time>
                    <span>
                      {item.sub && <span className="bold-screen-sub">Sub-agent · </span>}
                      {item.text}
                    </span>
                  </button>
                </li>
              )
            })}
          </ol>
        </section>

        <div className="bold-screen-main">
          <div
            className="bold-screen-stage"
            style={{ '--watch-agent': agent.style.color } as CSSProperties}
          >
            <span className="bold-screen-badge">
              {live ? 'Live' : `Replaying ${clock(marker!.at)}`}
            </span>
            <div className="bold-screen-stage-head">
              <span className="bold-screen-who">{agentDisplayName(agent)}’s screen</span>
              <div role="group" aria-label="Screens" className="bold-screen-surfaces">
                {surfaces.map((name) => (
                  <button
                    key={name}
                    type="button"
                    aria-pressed={top === name}
                    disabled={!stage.bySurface[name]}
                    className={top === name ? 'on' : undefined}
                    onClick={() => setSurface(name)}
                  >
                    {surfaceLabels[name]}
                  </button>
                ))}
              </div>
              <span className="bold-screen-readonly">Read-only</span>
            </div>
            <div className="bold-screen-window">
              {!frame && (
                <p className="bold-screen-empty">
                  {live
                    ? `${agentDisplayName(agent)} hasn’t opened anything yet.`
                    : 'Nothing was on screen at that moment.'}
                </p>
              )}
              {frame?.terminal && (
                <TerminalPane terminal={frame.terminal} history={history} live={live} />
              )}
              {frame?.editor && <EditorPane editor={frame.editor} />}
              {frame?.browser && <BrowserPane browser={frame.browser} />}
            </div>
            {live && waiting && <ApprovalBar key={waiting.id} approval={waiting} agent={agent} />}
            {!live && waiting && (
              <button
                type="button"
                className="bold-screen-needs-live"
                data-protected="inline-flex"
                onClick={() => {
                  setPlaying(false)
                  setSelected(null)
                }}
              >
                Needs you — go live
              </button>
            )}
          </div>

          <ScrubTimeline
            agent={agent}
            markers={markers}
            cursor={cursor}
            playing={playing}
            onSelect={select}
            onLive={() => {
              setPlaying(false)
              setSelected(null)
            }}
            onBack={() => {
              const target = backFrom(markers, cursor)
              if (target !== null) select(target)
            }}
            onTogglePlay={() => {
              if (cursor === null) {
                if (markers.length > 0) select(markers.length - 1)
              } else setPlaying(!playing)
            }}
          />
          <p className="bold-screen-note">
            You’re watching. {agentDisplayName(agent)} keeps working and can’t see you here.
          </p>
        </div>
      </div>
    </section>
  )
}

export function BoldScreenPage() {
  const { agentId = '' } = useParams()
  return <BoldScreenAgent key={agentId} agentId={agentId} />
}

function BoldScreenAgent({ agentId }: { agentId: string }) {
  const watch = useStreamQuery(watchQuery(agentId))
  useWatchLiveRefresh(agentId, null, watch.data?.agent.status === 'paused')
  const all = useStreamQuery(approvalsQuery)
  const pending = useStreamQuery(pendingApprovalsQuery(agentId))
  const approvals = useMemo(() => {
    const open = pending.data ?? []
    const ids = new Set(open.map((item) => item.id))
    return [
      ...open,
      ...(all.data ?? []).filter((item) => item.agentId === agentId && !ids.has(item.id)),
    ]
  }, [all.data, pending.data, agentId])

  if (!watch.data) {
    const missing = watch.error instanceof ApiError && watch.error.status === 404
    return (
      <section className="page bold-screen">
        <p className="bold-screen-state" role={watch.status === 'error' ? 'alert' : 'status'}>
          {watch.status === 'error'
            ? missing
              ? 'That agent doesn’t exist.'
              : 'Couldn’t load this screen.'
            : 'Loading the screen…'}{' '}
          {watch.status === 'error' && <Link to="/b">Back to the team room</Link>}
        </p>
      </section>
    )
  }
  return (
    <BoldScreenView
      agent={watch.data.agent}
      frames={watch.data.frames}
      markers={watch.data.markers}
      approvals={approvals}
    />
  )
}
