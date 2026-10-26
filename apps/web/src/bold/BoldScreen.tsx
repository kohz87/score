import type {
  AgentSummary,
  Approval,
  Job,
  Message,
  WatchFrame,
  WatchMarker,
  WatchOverviewItem,
} from '@score/contract'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type ReactNode,
} from 'react'
import { Link, useParams, useSearchParams } from 'react-router'
import { AgentGlyph } from '../components/AgentGlyph.tsx'
import { ApiError } from '../data/api.ts'
import { copyText } from '../data/clipboard.ts'
import { useStreamQuery } from '../data/query-client.ts'
import { useApprovalDecision } from '../routes/chat/ApprovalCard.tsx'
import { approvalsQuery } from '../routes/chat/queries.ts'
import { ScrubTimeline } from '../routes/watch/ScrubTimeline.tsx'
import { BrowserPane, EditorPane, TerminalPane } from '../routes/watch/WatchStage.tsx'
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
  clock,
  clockSeconds,
  groupActivity,
  hostOf,
  markerLabels,
  resumeCommand,
  stageAt,
  surfaceLabels,
  terminalHistory,
  type ActivityItem,
  type Surface,
} from '../routes/watch/watch-model.ts'
import { BoldLiveScreen } from './BoldLiveScreen.tsx'
import { agentDisplayName, agentMood, agentStateLabel } from './bold-agents.ts'
import { boldAgentScreenLink, boldJobLink } from './bold-links.ts'
import { approvalNeedsYou } from './room/room-model.ts'
import { roomMessagesQuery, teamRoomQuery } from './room/room-queries.ts'
import './bold-screen.css'

const surfaces: Surface[] = ['terminal', 'editor', 'browser']
const PLAY_MS = 1000

function pendingApproval(approvals: Approval[], agentId: string): Approval | null {
  const open = approvals.filter((item) => item.agentId === agentId && approvalNeedsYou(item))
  return open.sort((a, b) => b.createdAt.localeCompare(a.createdAt))[0] ?? null
}

function ApprovalBar({
  approval,
  agent,
  jobs,
  messages,
}: {
  approval: Approval
  agent: AgentSummary
  jobs: Job[]
  messages: Message[]
}) {
  const { busy, error, posted, decide } = useApprovalDecision(approval.id)
  const answered = posted !== null && posted.status !== 'pending'
  const current = posted ?? approval
  const sending = current.delivery === 'intent' || current.delivery === 'delivering'
  const retrying = current.actionable && current.delivery === 'failed'
  const disabled = busy || answered || sending
  const jobId = approvalJobId(current, jobs, messages)
  return (
    <div
      className="watch-approval bold-screen-approval"
      role="group"
      aria-label="Approval needed"
      data-protected="flex"
    >
      <span className="bold-screen-asked">Asked you at {clock(approval.createdAt)}</span>
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
        {sending && <span className="bold-screen-answer"> Sending…</span>}
        {retrying && (
          <span className="bold-screen-answer"> Couldn’t deliver your answer. Try again.</span>
        )}
        {error && (
          <span className="watch-approval__error" role="alert">
            {' '}
            {error}
          </span>
        )}
        {answered && <span className="bold-screen-answer">Answer sent.</span>}
      </span>
      <span className="bold-screen-approval-actions">
        {approval.actionable && approval.choices.includes('once') && (
          <button
            type="button"
            className="watch-approval__go"
            disabled={disabled}
            onClick={() => void decide('once')}
          >
            {sending ? 'Sending…' : retrying ? 'Retry' : 'Approve'}
          </button>
        )}
        {approval.actionable && approval.choices.includes('deny') && (
          <button
            type="button"
            className="watch-approval__no"
            disabled={disabled}
            onClick={() => void decide('deny')}
          >
            {sending ? 'Sending…' : 'Deny'}
          </button>
        )}
        {!approval.actionable && (
          <Link className="watch-approval__link" to={jobId ? boldJobLink(jobId) : '/b'}>
            {jobId ? 'Answer in the job' : 'Answer in the team room'}
          </Link>
        )}
      </span>
    </div>
  )
}

/** The job that holds the approval's card message; the contract's Approval itself has no job id. */
function approvalJobId(approval: Approval, jobs: Job[], messages: Message[]): string | null {
  const message = messages.find((item) =>
    item.parts.some((part) => part.kind === 'approval' && part.approvalId === approval.id),
  )
  return message?.jobId && jobs.some((job) => job.id === message.jobId) ? message.jobId : null
}

const surfaceIcons: Record<Surface, string> = {
  terminal: 'M5 8l4 4-4 4M12 17h7',
  editor: 'M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8zM14 3v5h5',
  browser:
    'M12 3a9 9 0 1 0 0 18 9 9 0 0 0 0-18zM3 12h18M12 3c3 3.5 3 14.5 0 18M12 3c-3 3.5-3 14.5 0 18',
}

function SurfaceIcon({ surface }: { surface: Surface }) {
  return (
    <svg
      width="14"
      height="14"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="2.2"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d={surfaceIcons[surface]} />
    </svg>
  )
}

const INITIAL_STEPS = 5

/** The step list: newest first, the five newest until "Full history", a sub-agent's steps grouped, one bounded scroll. */
function StepList({
  items,
  currentKey,
  live,
  targets,
  onSelect,
}: {
  items: ActivityItem[]
  currentKey: string | null
  live: boolean
  targets: (item: ActivityItem) => number
  onSelect: (item: ActivityItem) => void
}) {
  const [all, setAll] = useState(false)
  const entries = groupActivity(items)
  const holdsCurrent = (entry: (typeof entries)[number]) =>
    entry.type === 'item'
      ? entry.item.key === currentKey
      : entry.items.some((i) => i.key === currentKey)
  // A replayed step that fell outside the five newest opens the whole history, so the current step is always on screen.
  const currentHidden = entries.slice(INITIAL_STEPS).some(holdsCurrent)
  const expanded = all || currentHidden
  const shown = expanded ? entries : entries.slice(0, INITIAL_STEPS)
  const list = useRef<HTMLOListElement>(null)
  // While replaying, the replayed step is kept in view inside the list (never the page). Live, the newest step is
  // already first, so a reader scrolled down the history is left where they are.
  useEffect(() => {
    if (live) return
    const box = list.current
    const current = box?.querySelector<HTMLElement>('[aria-current="true"]')
    if (!box || !current) return
    const top =
      current.getBoundingClientRect().top - box.getBoundingClientRect().top + box.scrollTop
    if (top < box.scrollTop || top + current.offsetHeight > box.scrollTop + box.clientHeight)
      box.scrollTop = Math.max(0, top - 8)
  }, [currentKey, expanded, live])
  const row = (item: ActivityItem) => {
    const current = item.key === currentKey
    return (
      <li key={item.key}>
        <button
          type="button"
          className={`bold-screen-step${current ? ' sel' : ''}`}
          aria-current={current ? 'true' : undefined}
          disabled={targets(item) < 0}
          onClick={() => onSelect(item)}
        >
          <span
            className={`bold-screen-dot watch-marker--${item.kind}`}
            role="img"
            aria-label={markerLabels[item.kind]}
          />
          <time className="mono bold-screen-time" dateTime={item.at}>
            {live && item === items[0] ? 'now' : clockSeconds(item.at)}
          </time>
          <span>{item.text}</span>
        </button>
      </li>
    )
  }
  return (
    <>
      <ol ref={list} className="bold-screen-steps">
        {shown.map((entry) =>
          entry.type === 'item' ? (
            row(entry.item)
          ) : (
            <li key={entry.key} className="bold-screen-group">
              <span className="bold-screen-sub">
                Sub-agent · {entry.items.length} {entry.items.length === 1 ? 'step' : 'steps'}
              </span>
              <ol
                className="bold-screen-steps bold-screen-steps--nested"
                aria-label="Sub-agent steps"
              >
                {entry.items.map(row)}
              </ol>
            </li>
          ),
        )}
      </ol>
      {entries.length > INITIAL_STEPS && (
        <button
          type="button"
          className="bold-screen-more"
          aria-expanded={expanded}
          disabled={currentHidden && !all}
          onClick={() => setAll(!all)}
        >
          {expanded ? 'Show less' : 'Full history'}
        </button>
      )}
    </>
  )
}

/** The other two screens, small beside the large one: a short look at what is on them, and a button that swaps it large. */
function SmallScreen({
  surface,
  frame,
  onShow,
}: {
  surface: Surface
  frame: WatchFrame | undefined
  onShow: () => void
}) {
  const label = surfaceLabels[surface]
  const where = frame?.terminal
    ? frame.terminal.cwd
    : frame?.editor
      ? frame.editor.path
      : frame?.browser
        ? frame.browser.url
          ? hostOf(frame.browser.url)
          : (frame.browser.title ?? '')
        : ''
  return (
    <button
      type="button"
      className={`bold-screen-small bold-screen-small--${surface}`}
      disabled={!frame}
      aria-label={frame ? `${label}, ${where}. Show large` : `${label}, nothing open`}
      onClick={onShow}
    >
      <span className="bold-screen-small-head">
        <SurfaceIcon surface={surface} />
        {label}
        {where && <span className="bold-screen-small-where"> · {where}</span>}
      </span>
      {!frame && <span className="bold-screen-small-empty">Nothing open</span>}
      {frame?.terminal && (
        <span className="bold-screen-small-body mono">
          <span className="bold-screen-small-cmd">$ {frame.terminal.command}</span>
          {frame.terminal.output.split('\n').slice(-4).join('\n')}
        </span>
      )}
      {frame?.editor && (
        <span className="bold-screen-small-body mono">
          {frame.editor.diff.split('\n').slice(0, 6).join('\n')}
        </span>
      )}
      {frame?.browser && (
        <span className="bold-screen-small-page">
          <b>{frame.browser.title || 'Untitled page'}</b>
          <span>{frame.browser.url}</span>
        </span>
      )}
    </button>
  )
}

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
  const [command, setCommand] = useState<{ text: string; copied: boolean } | null>(null)
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
  const small = surfaces.filter((name) => name !== top)
  const currentKey = live
    ? (items[0]?.key ?? null)
    : marker?.kind === 'asked'
      ? (items.find((item) => item.kind === 'asked' && item.at === marker.at)?.key ?? null)
      : stage.front
        ? `frame-${stage.front.seq}`
        : null
  const waiting = pendingApproval(approvals, agent.id)
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
  const copyResume = async () => {
    const session = await (resumeSession?.() ?? Promise.resolve(null)).catch(() => null)
    const text = resumeCommand(agent.id, session)
    setCommand({ text, copied: await copyText(text) })
  }
  const otherScreens = (others?.items ?? []).filter((item) => item.agent.id !== agent.id)

  return (
    <section className="page bold-screen" aria-labelledby="bold-screen-title">
      <div className="pagehead bold-screen-head">
        <Link className="link" to="/b">
          Team room
        </Link>
        <span className="muted">/</span>
        <AgentGlyph agent={agent} size="lg" decorative mood={agentMood(agent)} />
        <div className="bold-screen-title">
          <h1 id="bold-screen-title">{agentDisplayName(agent)}’s screen</h1>
          <span className="muted">{agentStateLabel(agent)}</span>
        </div>
        <div className="bold-screen-actions">
          {pause && (
            <button
              type="button"
              className="btn ghost"
              disabled={pause.pending}
              onClick={pause.onToggle}
            >
              {paused ? 'Resume' : 'Pause'} {agentDisplayName(agent)}
            </button>
          )}
          <Link className="btn ghost bold-screen-terminal" to="/terminal">
            Open in terminal
          </Link>
        </div>
      </div>
      {pause?.failed && (
        <p className="bold-screen-state" role="alert">
          Couldn’t {paused ? 'resume' : 'pause'} {agentDisplayName(agent)}. Try again.
        </p>
      )}
      {from !== null && markers.length > 0 && from < markers[0]!.seq && (
        <p className="bold-screen-state" role="status">
          That moment is older than the history Score keeps, so the replay starts at the earliest
          one available.
        </p>
      )}
      {gaps > 0 && (
        <p className="bold-screen-state" role="status">
          Score missed some events ({gaps} gap{gaps === 1 ? '' : 's'}), so this replay may have
          holes.
        </p>
      )}

      <div className="bold-screen-layout">
        <div className="bold-screen-ask">
          {live && waiting && (
            <ApprovalBar
              key={waiting.id}
              approval={waiting}
              agent={agent}
              jobs={jobs}
              messages={messages}
            />
          )}
          {!live && waiting && (
            <button
              type="button"
              className="bold-screen-needs-live"
              data-protected="inline-flex"
              onClick={goLive}
            >
              Needs you — go live
            </button>
          )}
        </div>
        <div className="bold-screen-main">
          {liveScreen}
          <div
            className="bold-screen-stage"
            style={{ '--watch-agent': agent.style.color } as CSSProperties}
          >
            <span className="bold-screen-badge">
              {live ? 'Live' : `Replaying ${clock(marker!.at)}`}
            </span>
            {/* Announced when replay starts or ends, not on every scrub tick. */}
            <span className="sr-only" role="status">
              {live ? 'Live' : 'Replaying'}
            </span>
            <div className="bold-screen-stage-head">
              <span className="bold-screen-who">{agentDisplayName(agent)}’s screen</span>
              <span className="bold-screen-readonly">Read-only</span>
            </div>
            <div className="bold-screen-frames">
              <div className="bold-screen-window">
                {!frame && (
                  <p className="bold-screen-empty">
                    {live
                      ? `${agentDisplayName(agent)} hasn’t opened anything yet.`
                      : 'Nothing was on screen at that moment.'}
                  </p>
                )}
                {frame?.terminal && (
                  <TerminalPane
                    terminal={frame.terminal}
                    history={history}
                    live={live && (working ?? true)}
                  />
                )}
                {frame?.editor && <EditorPane editor={frame.editor} />}
                {frame?.browser && <BrowserPane browser={frame.browser} />}
              </div>
              <div role="group" aria-label="Other windows" className="bold-screen-smalls">
                {/* Keyed by place, not surface: the clicked button stays mounted (and focused) and now shows the screen that was large. */}
                {small.map((name, place) => (
                  <SmallScreen
                    key={place}
                    surface={name}
                    frame={stage.bySurface[name]}
                    onShow={() => {
                      setPinned({ from: front?.surface ?? null, surface: name })
                      setSwapped(`${surfaceLabels[name]} is now the large screen.`)
                    }}
                  />
                ))}
                <span className="sr-only" role="status">
                  {swapped}
                </span>
              </div>
            </div>
          </div>

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
          {others && (
            <nav className="bold-screen-others" aria-label="Other screens">
              <span className="bold-screen-others-title">Other screens</span>
              {others.items === undefined && (
                <span className="bold-screen-others-note" role={others.failed ? 'alert' : 'status'}>
                  {others.failed
                    ? 'Couldn’t load the other screens.'
                    : 'Loading the other screens…'}
                </span>
              )}
              {others.items && otherScreens.length === 0 && (
                <span className="bold-screen-others-note">
                  No other agents are on the team yet.
                </span>
              )}
              {otherScreens.map((item) => (
                <Link
                  key={item.agent.id}
                  className="bold-screen-chip"
                  to={boldAgentScreenLink(item.agent.id)}
                >
                  <AgentGlyph agent={item.agent} size="xs" decorative />
                  <span>{agentDisplayName(item.agent)}</span>
                  <span className="bold-screen-chip-status">
                    {item.live && <span className="bold-screen-chip-live" aria-hidden="true" />}
                    {item.status}
                  </span>
                </Link>
              ))}
            </nav>
          )}
        </div>
        <section className="bold-screen-log" aria-label={`What ${agentDisplayName(agent)} did`}>
          <h2 className="bold-screen-log-title">What {agentDisplayName(agent)} did</h2>
          {items.length === 0 && (
            <p className="bold-screen-empty">Nothing yet. Steps show up here as they happen.</p>
          )}
          <StepList
            items={items}
            currentKey={currentKey}
            live={live}
            targets={itemIndex}
            onSelect={selectItem}
          />
          <div className="bold-screen-card">
            <p>
              A replay of recorded steps, read-only. {agentDisplayName(agent)} keeps working and
              can’t see you here.
            </p>
            <button type="button" className="btn sm" onClick={() => void copyResume()}>
              Copy the command to continue in a terminal
            </button>
            {command && (
              <p role="status">
                {command.copied
                  ? 'Copied. Paste this in a terminal:'
                  : 'Select the command and press Ctrl+C, then run it in a terminal:'}{' '}
                <code className="bold-screen-command">{command.text}</code>
              </p>
            )}
          </div>
        </section>
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
  const [params] = useSearchParams()
  const fromParam = /^\d{1,12}$/.test(params.get('from') ?? '') ? Number(params.get('from')) : null
  const [anchor, setAnchor] = useState<number | null>(fromParam)
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
          <BoldLiveScreen agentId={data.agent.id} agentName={agentDisplayName(data.agent)} />
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
