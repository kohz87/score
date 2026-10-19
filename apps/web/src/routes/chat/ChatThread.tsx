import type { AgentSummary } from '@score/contract'
import {
  Fragment,
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { Link, useSearchParams } from 'react-router'
import { AgentGlyph } from '../../components/AgentGlyph.tsx'
import { StreamContext, useStreamQuery } from '../../data/query-client.ts'
import { ApiError } from '../../data/api.ts'
import { Composer } from './Composer.tsx'
import { DeleteToast } from './DeleteToast.tsx'
import { usePendingDeletes } from './message-deletion.ts'
import { MessageItem } from './MessageItem.tsx'
import { ImportedBanner } from './ImportedBanner.tsx'
import { RenameRoom } from './RenameRoom.tsx'
import { RoomStage } from './stage/RoomStage.tsx'
import { StageToggle } from './stage/StageToggle.tsx'
import { stageMembers } from './stage/stage-mood.ts'
import { StatusLine } from '../../live/StatusLine.tsx'
import { useStatusLines } from '../../live/use-activity.ts'
import { messagesQuery, roomQuery, versionsQuery } from './queries.ts'
import {
  BranchView,
  DeletedBlock,
  MessageVersionControl,
  OpenEditNotice,
  type VersionView,
} from './versions.tsx'
import { useShowDeleted } from './deleted-toggle.ts'
import { roomLabel } from './room-label.ts'
import { orchestrationsQuery, useRun } from '../orchestrations/orchestration-queries.ts'
import {
  UserRunNeeds,
  UserRunPanel,
  UserWorkflowNeeds,
  UserWorkflowPanel,
} from '../user/UserRun.tsx'
import { StatusMessageItem } from '../user/StatusMessageItem.tsx'
import { statusMessages } from '../user/status-messages.ts'
import { RoomRunPanel } from '../orchestrations/RoomRunPanel.tsx'
import { WorkflowRoomPanel } from '../workflows/WorkflowRoomPanel.tsx'
import { useStartOrchestration } from '../user/use-start-orchestration.tsx'
import { workflowRunsQuery } from '../workflows/workflow-queries.ts'

/** Something the thread draws between messages by its time without being a message. */
export interface ThreadExtra {
  id: string
  at: string
  node: ReactNode
}

export function QueryError({ text, retry }: { text: string; retry: () => void }) {
  return (
    <div className="chat-state" role="alert">
      <p>{text}</p>
      <button type="button" onClick={retry}>
        Try again
      </button>
    </div>
  )
}

function MessagePage({
  roomId,
  before = null,
  agents,
  excluded = [],
  seek = null,
  importedLabel,
  view,
  onView,
  onChange,
  onPrepend,
  extras = [],
  extraUntil = null,
}: {
  roomId: string
  before?: string | null
  agents: AgentSummary[]
  excluded?: string[]
  /** A message to scroll to (search hit): older pages load until it is found. */
  seek?: string | null
  /** Set in an imported room: its copied messages say where they came from. */
  importedLabel?: string | undefined
  /** An older version of an edited message on screen in place of that message and everything after it (PLAN 5.35). */
  view: VersionView
  onView: (view: VersionView) => void
  onChange: () => void
  onPrepend: () => void
  /** Lines the user view draws between messages by time (Score's status messages); never stored. */
  extras?: ThreadExtra[]
  /** The first message time of the page below this one: lines from there on belong to that page. */
  extraUntil?: string | null
}) {
  const definition = useMemo(() => messagesQuery(roomId, before), [roomId, before])
  const { data, status } = useStreamQuery(definition)
  const context = useContext(StreamContext)!
  const [older, setOlder] = useState<string | null>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const loadOlder = useCallback(() => {
    if (!data?.nextCursor || older) return
    onPrepend()
    setOlder(data.nextCursor)
  }, [data, older, onPrepend])
  useEffect(() => {
    if (!seek || !data || data.items.some((item) => item.id === seek)) return
    const timer = setTimeout(loadOlder, 0)
    return () => clearTimeout(timer)
  }, [seek, data, loadOlder])
  useEffect(() => {
    if (!trigger.current || !globalThis.IntersectionObserver) return
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) loadOlder()
    })
    observer.observe(trigger.current)
    return () => observer.disconnect()
  }, [loadOlder, status])
  useLayoutEffect(() => {
    if (data && status === 'success') onChange()
  }, [data, status, onChange])
  const hidden = usePendingDeletes().hidden
  const versionsDefinition = useMemo(() => versionsQuery(roomId), [roomId])
  const versions = useStreamQuery(versionsDefinition).data ?? []
  const showDeleted = useShowDeleted(roomId)
  const items =
    data?.items.filter((item) => !excluded.includes(item.id) && !hidden.has(item.id)) ?? []
  // A resync can move the latest page boundary; follow its fresh cursor to avoid a gap.
  const olderCursor = older ? data?.nextCursor : null
  return (
    <>
      {olderCursor ? (
        <MessagePage
          key={olderCursor}
          roomId={roomId}
          before={olderCursor}
          agents={agents}
          excluded={[...excluded, ...items.map((item) => item.id)]}
          seek={seek}
          importedLabel={importedLabel}
          view={view}
          onView={onView}
          onChange={onChange}
          onPrepend={onPrepend}
          extras={extras}
          extraUntil={items.reduce<string | null>(
            (first, item) => (first === null || item.createdAt < first ? item.createdAt : first),
            extraUntil,
          )}
        />
      ) : (
        data?.nextCursor && (
          <button className="chat-history" type="button" ref={trigger} onClick={loadOlder}>
            Load older messages
          </button>
        )
      )}
      {status === 'pending' && (
        <p className="chat-state" role="status">
          Loading messages…
        </p>
      )}
      {status === 'error' && (
        <QueryError
          text="Couldn’t load messages."
          retry={() => void context.queries.register(definition).refetch()}
        />
      )}
      {data && !data.items.length && status === 'success' && before === null && (
        <p className="chat-state">No messages yet.</p>
      )}
      {(() => {
        const sorted = [...items].sort(
          (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
        )
        const oldest = sorted[0]?.createdAt
        const newest = sorted.at(-1)?.createdAt
        // Deleted messages only show when asked for; an edit that was never sent keeps a notice with Continue editing.
        const viewing = view ? items.find((item) => item.id === view.messageId) : undefined
        const cutoff = (value: { createdAt: string; id: string }) =>
          viewing !== undefined &&
          (value.createdAt.localeCompare(viewing.createdAt) ||
            value.id.localeCompare(viewing.id)) >= 0
        const markers = versions.filter(
          (version) =>
            ((showDeleted && version.mode === 'delete') ||
              (version.mode === 'edit' && version.replacedBy === null)) &&
            // While an older version is on screen, nothing after the edited message shows.
            !(viewing && version.anchorCreatedAt >= viewing.createdAt) &&
            ((before === null && (!newest || version.anchorCreatedAt > newest)) ||
              (oldest !== undefined &&
                newest !== undefined &&
                version.anchorCreatedAt >= oldest &&
                version.anchorCreatedAt <= newest) ||
              (!data?.nextCursor && oldest !== undefined && version.anchorCreatedAt < oldest) ||
              (!data?.nextCursor && !oldest && before === null)),
        )
        const nodes: ReactNode[] = []
        const pending = [...markers].sort((a, b) =>
          a.anchorCreatedAt.localeCompare(b.anchorCreatedAt),
        )
        // Each page draws the lines from its first message up to the next page's first message.
        const lines = extras
          .filter(
            (extra) =>
              (extraUntil === null || extra.at < extraUntil) &&
              (!data?.nextCursor || (oldest !== undefined && extra.at >= oldest)),
          )
          .sort((a, b) => a.at.localeCompare(b.at))
        const flushLines = (until: string | null) => {
          while (lines[0] && (until === null || lines[0].at <= until)) {
            const line = lines.shift()!
            nodes.push(<Fragment key={`x-${line.id}`}>{line.node}</Fragment>)
          }
        }
        const flush = (until: string | null) => {
          flushLines(until)
          while (pending[0] && (until === null || pending[0].anchorCreatedAt <= until)) {
            const version = pending.shift()!
            nodes.push(
              version.mode === 'delete' ? (
                <DeletedBlock
                  key={`v-${version.id}`}
                  version={version}
                  versions={versions}
                  agents={agents}
                />
              ) : (
                <OpenEditNotice
                  key={`v-${version.id}`}
                  version={version}
                  versions={versions}
                  agents={agents}
                />
              ),
            )
          }
        }
        for (const message of sorted) {
          if (cutoff(message)) {
            if (message.id === view?.messageId)
              nodes.push(
                <BranchView
                  key={`branch:${message.id}`}
                  messageId={message.id}
                  version={view.version}
                  versions={versions}
                  agents={agents}
                  onSelect={(next) =>
                    onView(next ? { messageId: message.id, version: next } : null)
                  }
                />,
              )
            continue
          }
          flush(message.createdAt)
          nodes.push(
            <MessageItem
              key={message.id}
              message={message}
              agents={agents}
              importedLabel={importedLabel}
              versionControl={
                <MessageVersionControl
                  messageId={message.id}
                  versions={versions}
                  onSelect={(version) => onView({ messageId: message.id, version })}
                />
              }
            />,
          )
        }
        flush(null)
        flushLines(null)
        return nodes
      })()}
      {before === null && (
        <div className="chat-typing" role="status" aria-live="polite">
          {Object.entries(data?.typing ?? {}).map(([id, text]) => {
            const agent = agents.find((item) => item.id === id)
            return (
              <div key={id} className="chat-agent-label">
                {agent && <AgentGlyph agent={agent} size="xs" bare decorative />}
                <span>
                  {agent?.name ?? id} {text}
                </span>
              </div>
            )
          })}
        </div>
      )}
    </>
  )
}

/** The agents of the room that are working, each with what it is doing now. The line keeps its height when empty. */
function RoomStatus({ working, agents }: { working: string[]; agents: AgentSummary[] }) {
  const lines = useStatusLines(working.map((id) => ({ id, working: true })))
  const shown = working.flatMap((id) => {
    const agent = agents.find((item) => item.id === id)
    const line = lines.get(id)
    return agent && line ? [{ agent, line }] : []
  })
  return (
    <ul className="chat-room-status" aria-label="Working now">
      {shown.slice(0, 3).map(({ agent, line }) => (
        <li key={agent.id}>
          <AgentGlyph agent={agent} size="xs" bare decorative />
          <strong>{agent.name}</strong>
          <StatusLine line={line} reserve={false} />
        </li>
      ))}
      {shown.length > 3 && <li>and {shown.length - 3} more</li>}
    </ul>
  )
}

export function ChatThread({
  roomId,
  agents,
  variant = 'admin',
}: {
  roomId: string
  agents: AgentSummary[]
  /** The user view (PLAN 8.4) shows the same conversation without the admin links and controls. */
  variant?: 'admin' | 'user'
}) {
  const userView = variant === 'user'
  const starter = useStartOrchestration(agents)
  const definition = useMemo(() => roomQuery(roomId), [roomId])
  const { data: room, status, error } = useStreamQuery(definition)
  const context = useContext(StreamContext)!
  const viewport = useRef<HTMLDivElement>(null)
  const [params] = useSearchParams()
  const seek = params.get('message')
  const seekRef = useRef<{ id: string | null; done: string | null }>({ id: seek, done: null })
  const position = useRef({ height: 0, top: 0, pinned: !seek, prepend: false })
  // When the person last used the wheel, touch, keyboard or pointer on the thread.
  const intent = useRef(-Infinity)
  const markIntent = useCallback(() => {
    intent.current = performance.now()
  }, [])
  const onPrepend = useCallback(() => {
    position.current.prepend = true
    if (document.activeElement?.classList.contains('chat-history')) {
      viewport.current?.focus({ preventScroll: true })
    }
  }, [])
  const onChange = useCallback(() => {
    const element = viewport.current
    if (!element) return
    const state = position.current
    const target = seekRef.current
    if (target.id && target.done !== target.id) {
      // A search hit: bring the message into view once it has loaded, and keep the view there.
      const found = document.getElementById(`message-${target.id}`)
      if (found) {
        target.done = target.id
        state.pinned = false
        found.scrollIntoView?.({ block: 'center' })
        found.classList.add('chat-message--hit')
        found.focus({ preventScroll: true })
      }
    } else if (state.prepend) element.scrollTop += element.scrollHeight - state.height
    else if (state.pinned) element.scrollTop = element.scrollHeight
    state.height = element.scrollHeight
    // Our own write queued a scroll event that arrives a frame later; until then `top` must already say where we put
    // the thread, or a layout clamp in between cannot be told apart from where the thread stood (see onScroll).
    state.top = element.scrollTop
    state.prepend = false
  }, [])
  // The thread's size changes after it was pinned to its end: the composer grows (the context ring and pickers settle a
  // moment after the first paint) or a message grows (code highlighting, fonts, images). Neither fires a scroll event,
  // so the last lines would stay hidden: follow the end while the person is at the end.
  const hasRoom = Boolean(room)
  useEffect(() => {
    const element = viewport.current
    if (!hasRoom || !element || typeof ResizeObserver === 'undefined') return
    const follow = () => {
      if (!position.current.pinned) return
      element.scrollTop = element.scrollHeight
      position.current.height = element.scrollHeight
      position.current.top = element.scrollTop
    }
    const resize = new ResizeObserver(follow)
    const watch = () => {
      resize.observe(element)
      for (const child of element.children) resize.observe(child)
    }
    watch()
    const children = new MutationObserver(watch)
    children.observe(element, { childList: true })
    return () => {
      resize.disconnect()
      children.disconnect()
    }
  }, [hasRoom])
  // Opening another hit in the same room.
  useEffect(() => {
    seekRef.current.id = seek
    if (seek) {
      position.current.pinned = false
      onChange()
    }
  }, [seek, onChange])
  // A new rewind changes what the thread shows: leave the older version being viewed.
  const [view, setView] = useState<VersionView>(null)
  const versionsDefinition = useMemo(() => versionsQuery(roomId), [roomId])
  const versionCount = useStreamQuery(versionsDefinition).data?.length
  const [seenVersions, setSeenVersions] = useState(versionCount)
  if (seenVersions !== versionCount) {
    setSeenVersions(versionCount)
    setView(null)
  }
  const [renaming, setRenaming] = useState(false)
  const lead = agents.find((agent) => agent.id === room?.leadAgentId)
  const orchestration = useStreamQuery(orchestrationsQuery).data?.find(
    (item) => item.roomId === roomId,
  )
  // A workflow run owns its room the same way (contract §15).
  const workflowRun = useStreamQuery(workflowRunsQuery).data?.find((item) => item.roomId === roomId)
  // The user view tells how the run is going in the thread, from the run's recorded events.
  const runData = useRun(userView ? orchestration?.id : undefined).data
  const extras = useMemo<ThreadExtra[]>(() => {
    if (!userView || !runData) return []
    const steps = runData.snapshot.orchestration.stepsList
    return statusMessages(runData.events, {
      stepAgent: (id) => {
        const agentId = steps.find((step) => step.id === id)?.agentId
        return agentId ? (agents.find((agent) => agent.id === agentId)?.name ?? agentId) : null
      },
    }).map((message) => ({
      id: message.id,
      at: message.at,
      node: <StatusMessageItem message={message} />,
    }))
  }, [userView, runData, agents])
  const owned = (orchestration ?? workflowRun)?.ownership
  const roomIsOwned = owned !== undefined && owned !== 'released'
  return (
    <section className={`chat-thread${userView ? ' chat-thread--user' : ''}`} aria-label="Room">
      <header className="chat-thread-header">
        <div>
          {room && renaming ? (
            <RenameRoom
              room={room}
              className="chat-rename--title"
              onDone={() => setRenaming(false)}
              onCancel={() => setRenaming(false)}
            />
          ) : (
            <h1>
              {room?.kind === 'room' && !userView ? (
                <button
                  type="button"
                  className="chat-title-button"
                  title="Rename this room"
                  aria-label={`${roomLabel(room)} (rename)`}
                  onClick={() => setRenaming(true)}
                >
                  {roomLabel(room)}
                </button>
              ) : room ? (
                userView && orchestration ? (
                  orchestration.title
                ) : userView && room.kind === 'direct' ? (
                  (lead?.name ?? roomLabel(room))
                ) : (
                  roomLabel(room)
                )
              ) : (
                'Chat'
              )}
            </h1>
          )}
          {room?.leadAgentId && <p>Unaddressed messages go to {lead?.name ?? room.leadAgentId}</p>}
          {room && <RoomStatus working={room.activeAgents} agents={agents} />}
        </div>
        {!userView && room && stageMembers(room, agents).length > 0 && <StageToggle />}
        {!userView && (
          <Link className="chat-score-link" to="/now">
            See it on the Score
          </Link>
        )}
      </header>
      {!userView && room && <RoomStage room={room} agents={agents} />}
      {status === 'pending' && !room && (
        <p className="chat-state" role="status">
          Loading room…
        </p>
      )}
      {status === 'error' && (
        <QueryError
          text={
            error instanceof ApiError && error.status === 404
              ? 'Room not found.'
              : 'Couldn’t load room.'
          }
          retry={() => void context.queries.register(definition).refetch()}
        />
      )}
      {room?.importedFrom && <ImportedBanner room={room} agents={agents} />}
      {room && (
        <div
          className="chat-scroll"
          ref={viewport}
          tabIndex={0}
          role="region"
          aria-label="Message history"
          onWheel={markIntent}
          onTouchMove={markIntent}
          onPointerDown={markIntent}
          onKeyDown={markIntent}
          onScroll={() => {
            const element = viewport.current!
            const state = position.current
            const distance = element.scrollHeight - element.scrollTop - element.clientHeight
            // A layout that flips back and forth inside one frame (the composer settling) clamps the offset up the
            // thread without any resize notification. Nobody touched the thread and it is still next to its end:
            // that was the layout, not the person, so stay at the end. `top` is where the last scroll event or our own
            // write left the thread, so a clamp below it is seen even when it happens before that write's event.
            const moved =
              state.pinned && distance > 1 && distance < 80 && element.scrollTop < state.top
            if (moved && performance.now() - intent.current > 600)
              element.scrollTop = element.scrollHeight
            else state.pinned = distance < 80
            state.top = element.scrollTop
            state.height = element.scrollHeight
          }}
        >
          {orchestration &&
            (userView ? (
              <UserRunPanel summary={orchestration} />
            ) : (
              <RoomRunPanel summary={orchestration} agents={agents} />
            ))}
          {workflowRun &&
            (userView ? (
              <UserWorkflowPanel summary={workflowRun} />
            ) : (
              <WorkflowRoomPanel summary={workflowRun} agents={agents} />
            ))}
          <div className="chat-messages">
            <MessagePage
              roomId={roomId}
              agents={agents}
              seek={seek}
              importedLabel={room.importedFrom?.label}
              view={view}
              onView={setView}
              onChange={onChange}
              onPrepend={onPrepend}
              extras={extras}
            />
            {userView && orchestration && <UserRunNeeds summary={orchestration} agents={agents} />}
            {userView && workflowRun && <UserWorkflowNeeds summary={workflowRun} agents={agents} />}
          </div>
        </div>
      )}
      <DeleteToast />
      {room && roomIsOwned && (
        <div className="chat-composer-locked">
          <textarea
            disabled
            rows={1}
            aria-label="Message"
            placeholder={
              userView && !workflowRun
                ? 'This room belongs to a running orchestration. Answer in the chat above, or use Pause or Stop.'
                : `This room belongs to a running ${workflowRun ? 'workflow' : 'orchestration'}. Use the run controls above.`
            }
          />
        </div>
      )}
      {room && !roomIsOwned && (
        // The composer stays mounted (keeping a draft) but is out of reach while an older version is on screen.
        <div className={view ? undefined : 'chat-composer-slot'} hidden={view !== null}>
          <Composer
            roomId={roomId}
            roomName={room.name}
            agents={agents}
            leadAgentId={room.leadAgentId}
            {...(userView ? { orchestrate: starter.start } : {})}
          />
        </div>
      )}
      {userView && starter.dialog}
    </section>
  )
}
