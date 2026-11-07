import type {
  AgentSummary,
  Approval,
  Job,
  Message,
  WatchFrame,
  WatchMarker,
  WatchOverviewItem,
} from '@score/contract'
import { useCallback, useEffect, useMemo, useState, type ReactNode } from 'react'
import { Link, useParams, useSearchParams } from 'react-router'
import { ApiError } from '../data/api.ts'
import { useStreamQuery } from '../data/query-client.ts'
import { approvalsQuery } from '../routes/chat/queries.ts'
import { ScrubTimeline } from '../routes/watch/ScrubTimeline.tsx'
import '../routes/watch/watch.css'
import {
  fetchCurrentSession,
  pendingApprovalsQuery,
  useAgentPause,
  useWatchLiveRefresh,
  useWatchOverview,
  watchQuery,
} from '../routes/watch/watch-queries.ts'
import {
  activityItems,
  backFrom,
  stageAt,
  surfaceLabels,
  terminalHistory,
  type ActivityItem,
  type Surface,
} from '../routes/watch/watch-model.ts'
import { BoldLiveScreen } from './BoldLiveScreen.tsx'
import { BoldScreenAsk } from './BoldScreenApproval.tsx'
import { BoldScreenHeader } from './BoldScreenHeader.tsx'
import { BoldScreenLog } from './BoldScreenLog.tsx'
import { BoldScreenOtherScreens } from './BoldScreenOtherScreens.tsx'
import { BoldScreenStage } from './BoldScreenStage.tsx'
import { agentDisplayName } from './bold-agents.ts'
import { roomMessagesQuery, teamRoomQuery } from './room/room-queries.ts'
import './bold-screen.css'

const PLAY_MS = 1000

export function BoldScreenView({
  agent,
  frames,
  markers,
  approvals,
  jobs = [],
  messages = [],
  gaps = 0,
  working,
  from = null,
  onMoment,
  onLive,
  pause,
  resumeSession,
  others,
  liveScreen,
}: {
  /** The live Bot Desktop card, shown above the replay's surfaces (the page supplies it). */
  liveScreen?: ReactNode
  agent: AgentSummary
  frames: WatchFrame[]
  markers: WatchMarker[]
  approvals: Approval[]
  /** The team room's jobs and loaded messages: an approval's card names its job there. */
  jobs?: Job[]
  messages?: Message[]
  /** Stretches of events Score missed, so the replay may have holes. */
  gaps?: number
  /** Whether the agent has a run going (the terminal's live region); defaults to following the replay position. */
  working?: boolean
  /** History's "Replay" link: open the replay at the first moment at or after this event. */
  from?: number | null
  /** The replay moved to this event, so the page can load the frames around it. */
  onMoment?: (seq: number) => void
  /** The replay went back to live. */
  onLive?: () => void
  pause?: { pending: boolean; failed: boolean; onToggle: () => void }
  /** Reads the agent's current session for the resume command (run events do not carry it). */
  resumeSession?: () => Promise<string | null>
  others?: { items: WatchOverviewItem[] | undefined; failed: boolean }
}) {
  const [selected, setSelected] = useState<WatchMarker | null>(null)
  const [playing, setPlaying] = useState(false)
  const [pinned, setPinned] = useState<{ from: Surface | null; surface: Surface } | null>(null)
  const [swapped, setSwapped] = useState('')
  const [fromApplied, setFromApplied] = useState(from === null)
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
  if (!fromApplied && from !== null && markers.length > 0) {
    setFromApplied(true)
    const index = markers.findIndex((candidate) => candidate.seq >= from)
    setSelected(markers[index >= 0 ? index : markers.length - 1] ?? null)
  }
  const stage = useMemo(() => stageAt(frames, seq), [frames, seq])
  const items = useMemo(() => activityItems(frames, approvals), [frames, approvals])
  // The large slot follows the newest frame's surface (as the classic stage did); a click holds the person's choice
  // until the agent moves to another surface (more frames on the same one keep it).
  const front = stage.front
  const pin = pinned && pinned.from === (front?.surface ?? null) ? pinned.surface : null
  const top: Surface | null = pin && stage.bySurface[pin] ? pin : (front?.surface ?? null)
  const frame = top ? (stage.bySurface[top] ?? null) : null
  const currentKey = live
    ? (items[0]?.key ?? null)
    : marker?.kind === 'asked'
      ? (items.find((item) => item.kind === 'asked' && item.at === marker.at)?.key ?? null)
      : stage.front
        ? `frame-${stage.front.seq}`
        : null
  const paused = agent.status === 'paused'
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
        onLive?.()
      } else {
        const next = markers[cursor + 1] ?? null
        setSelected(next)
        if (next) onMoment?.(next.seq)
      }
    }, PLAY_MS)
    return () => clearInterval(timer)
  }, [cursor, markers, playing, onLive, onMoment])

  const select = (index: number) => {
    setPlaying(false)
    const next = markers[index] ?? null
    setSelected(next)
    if (next) onMoment?.(next.seq)
  }
  const goLive = () => {
    setPlaying(false)
    setSelected(null)
    onLive?.()
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
  return (
    <section className="page bold-screen" aria-labelledby="bold-screen-title">
      <BoldScreenHeader
        agent={agent}
        paused={paused}
        pause={pause}
        from={from}
        markers={markers}
        gaps={gaps}
      />

      <div className="bold-screen-layout">
        <BoldScreenAsk
          live={live}
          approvals={approvals}
          agent={agent}
          jobs={jobs}
          messages={messages}
          onGoLive={goLive}
        />
        <div className="bold-screen-main">
          {liveScreen}
          <BoldScreenStage
            agent={agent}
            live={live}
            marker={marker}
            stage={stage}
            frame={frame}
            top={top}
            history={history}
            working={working}
            swapped={swapped}
            onShowSmall={(surface) => {
              setPinned({ from: front?.surface ?? null, surface })
              setSwapped(`${surfaceLabels[surface]} is now the large screen.`)
            }}
          />

          <ScrubTimeline
            agent={agent}
            markers={markers}
            cursor={cursor}
            playing={playing}
            onSelect={select}
            onLive={goLive}
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
          {others && <BoldScreenOtherScreens agent={agent} others={others} />}
        </div>
        <BoldScreenLog
          agent={agent}
          items={items}
          currentKey={currentKey}
          live={live}
          targets={itemIndex}
          onSelect={selectItem}
          resumeSession={resumeSession}
        />
      </div>
    </section>
  )
}

/** Reads one job's latest message page; the screen needs the page that holds an approval's card message. */
function ApprovalMessagesCollector({
  roomId,
  jobId,
  onMessages,
}: {
  roomId: string
  jobId: string
  onMessages: (messages: Message[]) => void
}) {
  const definition = useMemo(() => roomMessagesQuery(roomId, jobId, null, jobId), [jobId, roomId])
  const page = useStreamQuery(definition)
  useEffect(() => {
    if (page.data) onMessages(page.data.items)
  }, [onMessages, page.data])
  return null
}

export function BoldScreenPage() {
  const { agentId = '' } = useParams()
  return <BoldScreenAgent key={agentId} agentId={agentId} />
}

function BoldScreenAgent({ agentId }: { agentId: string }) {
  // ?from=<seq> (History's Replay link) opens the replay at that moment; the frame window starts at the newest frames,
  // so a moment outside it re-anchors the window there.
  const [params, setParams] = useSearchParams()
  const fromParam = /^\d{1,12}$/.test(params.get('from') ?? '') ? Number(params.get('from')) : null
  const [anchor, setAnchor] = useState<number | null>(fromParam)
  const dropTake = useCallback(
    () =>
      setParams(
        (current) => {
          const next = new URLSearchParams(current)
          next.delete('take')
          return next
        },
        { replace: true },
      ),
    [setParams],
  )
  const watch = useStreamQuery(watchQuery(agentId, anchor))
  // Moving the frame window re-fetches under a new key; keep the last page on screen so the replay position survives.
  const [kept, setKept] = useState(watch.data)
  if (watch.data && watch.data !== kept) setKept(watch.data)
  const data = watch.data ?? kept
  const overview = useWatchOverview()
  const pause = useAgentPause(agentId)
  const team = useStreamQuery(teamRoomQuery(null))
  const teamData = team.data
  const jobs = teamData?.jobs ?? []
  const [messagesByJob, setMessagesByJob] = useState<Record<string, Message[] | undefined>>({})
  const reportMessages = useCallback((jobId: string, items: Message[]) => {
    setMessagesByJob((current) =>
      current[jobId] === items ? current : { ...current, [jobId]: items },
    )
  }, [])
  const messages = useMemo(
    () => Object.values(messagesByJob).flatMap((items) => items ?? []),
    [messagesByJob],
  )
  const first = data?.frames[0]?.seq
  const last = data?.frames.at(-1)?.seq
  const onMoment = useCallback(
    (seq: number) => {
      if (first !== undefined && last !== undefined && (seq < first || seq > last)) setAnchor(seq)
    },
    [first, last],
  )
  const onLive = useCallback(() => setAnchor(null), [])
  useWatchLiveRefresh(agentId, anchor, data?.agent.status === 'paused')
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

  if (!data) {
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
    <>
      {teamData?.jobs.map((job) => (
        <ApprovalMessagesCollector
          key={job.id}
          roomId={teamData.room.id}
          jobId={job.id}
          onMessages={(items) => reportMessages(job.id, items)}
        />
      ))}
      <BoldScreenView
        liveScreen={
          <BoldLiveScreen
            agentId={data.agent.id}
            agentName={agentDisplayName(data.agent)}
            openConfirm={params.get('take') === '1'}
            onConfirmShown={dropTake}
          />
        }
        agent={data.agent}
        frames={data.frames}
        markers={data.markers}
        approvals={approvals}
        jobs={jobs}
        messages={messages}
        gaps={data.gaps.length}
        working={data.live}
        from={fromParam}
        onMoment={onMoment}
        onLive={onLive}
        pause={{
          pending: pause.isPending,
          failed: pause.isError,
          onToggle: () => pause.mutate(data?.agent.status === 'paused' ? 'resume' : 'pause'),
        }}
        resumeSession={() => fetchCurrentSession(agentId).catch(() => data?.sessionId ?? null)}
        others={{ items: overview.items, failed: overview.isError }}
      />
    </>
  )
}
