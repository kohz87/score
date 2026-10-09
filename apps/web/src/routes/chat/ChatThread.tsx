import type { AgentSummary } from '@score/contract'
import {
  useCallback,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react'
import { Link } from 'react-router'
import { AgentGlyph } from '../../components/AgentGlyph.tsx'
import { StreamContext, useStreamQuery } from '../../data/query-client.ts'
import { ApiError } from '../../data/api.ts'
import { Composer } from './Composer.tsx'
import { DeleteToast } from './DeleteToast.tsx'
import { usePendingDeletes } from './message-deletion.ts'
import { MessageItem } from './MessageItem.tsx'
import { messagesQuery, roomQuery } from './queries.ts'
import { roomLabel } from './room-label.ts'

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
  onChange,
  onPrepend,
}: {
  roomId: string
  before?: string | null
  agents: AgentSummary[]
  excluded?: string[]
  onChange: () => void
  onPrepend: () => void
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
          onChange={onChange}
          onPrepend={onPrepend}
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
          text="Could not load messages."
          retry={() => void context.queries.register(definition).refetch()}
        />
      )}
      {data && !data.items.length && status === 'success' && before === null && (
        <p className="chat-state">No messages yet.</p>
      )}
      {[...items]
        .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
        .map((message) => (
          <MessageItem key={message.id} message={message} agents={agents} />
        ))}
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

export function ChatThread({ roomId, agents }: { roomId: string; agents: AgentSummary[] }) {
  const definition = useMemo(() => roomQuery(roomId), [roomId])
  const { data: room, status, error } = useStreamQuery(definition)
  const context = useContext(StreamContext)!
  const viewport = useRef<HTMLDivElement>(null)
  const position = useRef({ height: 0, pinned: true, prepend: false })
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
    if (state.prepend) element.scrollTop += element.scrollHeight - state.height
    else if (state.pinned) element.scrollTop = element.scrollHeight
    state.height = element.scrollHeight
    state.prepend = false
  }, [])
  const lead = agents.find((agent) => agent.id === room?.leadAgentId)
  return (
    <section className="chat-thread" aria-label="Conversation">
      <header className="chat-thread-header">
        <div>
          <h1>{room ? roomLabel(room) : 'Chat'}</h1>
          {room?.leadAgentId && <p>Unaddressed messages go to {lead?.name ?? room.leadAgentId}</p>}
        </div>
        <Link className="chat-score-link" to="/now">
          See it on the Score
        </Link>
      </header>
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
              : 'Could not load room.'
          }
          retry={() => void context.queries.register(definition).refetch()}
        />
      )}
      {room && (
        <div
          className="chat-scroll"
          ref={viewport}
          tabIndex={0}
          role="region"
          aria-label="Message history"
          onScroll={() => {
            const element = viewport.current!
            position.current.pinned =
              element.scrollHeight - element.scrollTop - element.clientHeight < 80
            position.current.height = element.scrollHeight
          }}
        >
          <div className="chat-messages">
            <MessagePage
              roomId={roomId}
              agents={agents}
              onChange={onChange}
              onPrepend={onPrepend}
            />
          </div>
        </div>
      )}
      <DeleteToast />
      {room && (
        <Composer
          roomId={roomId}
          roomName={room.name}
          agents={agents}
          leadAgentId={room.leadAgentId}
        />
      )}
    </section>
  )
}
