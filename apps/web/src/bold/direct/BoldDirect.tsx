import type { AgentSummary, Job, Room } from '@score/contract'
import { useEffect, useMemo, useState } from 'react'
import { useNavigate } from 'react-router'
import { AgentGlyph } from '../../components/AgentGlyph.tsx'
import { useStreamQuery, useStreamQueryRefetch } from '../../data/query-client.ts'
import { Composer } from '../../routes/chat/Composer.tsx'
import { ContextMeter } from '../../routes/chat/ContextMeter.tsx'
import { MessageItem } from '../../routes/chat/MessageItem.tsx'
import { saveDraft } from '../../routes/chat/composer-model.ts'
import { useBoldTeamRoom } from '../bold-search-queries.ts'
import { agentNameColor } from '../bold-agents.ts'
import { CloseIcon, HistoryIcon, LockIcon } from '../BoldIcons.tsx'
import { boldChatLink, boldChatRefLink, boldJobLink, boldOneToOneLink } from '../bold-links.ts'
import {
  directChatsQuery,
  createDirectChat,
  moveChatToTeamRoom,
  shareMessageToJob,
} from './direct-queries.ts'
import { roomMessagesQuery } from '../room/room-queries.ts'
import './bold-direct.css'

function chatDay(iso: string): string {
  const date = new Date(iso)
  const now = new Date()
  const sameDay = date.toDateString() === now.toDateString()
  if (sameDay) return 'Today'
  const yesterday = new Date(now)
  yesterday.setDate(now.getDate() - 1)
  if (date.toDateString() === yesterday.toDateString()) return 'Yesterday'
  return date.toLocaleDateString([], { month: 'short', day: 'numeric' })
}

function matchesChat(chat: Job, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  return `${chat.title}\n${chat.summary ?? ''}`.toLowerCase().includes(needle)
}

/** "Earlier chats" in the side panel head: search, New chat, and this agent's jobs (PLAN 11.7). */
export function DirectHeaderActions({
  agent,
  chatId,
  iconOnly = false,
}: {
  agent: AgentSummary
  chatId: string | null
  /** Board 19's phone head: the same disclosure as a 44px icon button. */
  iconOnly?: boolean
}) {
  const definition = useMemo(() => directChatsQuery(agent.id), [agent.id])
  const state = useStreamQuery(definition)
  const refetch = useStreamQueryRefetch(definition)
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const chats = (state.data?.chats ?? []).filter((chat) => matchesChat(chat, query))

  function pick(id: string) {
    setOpen(false)
    setQuery('')
    navigate(boldChatLink(agent.id, id))
  }

  async function newChat() {
    setBusy(true)
    setError(null)
    try {
      const chat = await createDirectChat(agent.id)
      await refetch()
      setOpen(false)
      setQuery('')
      navigate(boldChatLink(agent.id, chat.id))
    } catch {
      setError('Couldn’t start a chat. Try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <>
      <button
        type="button"
        className={`btn sm bold-dm-history-button${iconOnly ? ' bold-dm-history-icon' : ''}`}
        aria-haspopup="dialog"
        aria-expanded={open}
        aria-label="Earlier chats"
        onClick={() => {
          setOpen((value) => !value)
          setError(null)
        }}
      >
        <HistoryIcon />
        {!iconOnly && <span>Earlier chats</span>}
      </button>
      {open && (
        <div
          className="menu bold-dm-history"
          role="dialog"
          aria-label={`Earlier chats with ${agent.id}`}
        >
          <div className="bold-dm-history-search">
            <HistoryIcon size={15} />
            <label className="bold-sr-only" htmlFor={`dm-history-${agent.id}`}>
              Search chats
            </label>
            <input
              id={`dm-history-${agent.id}`}
              value={query}
              autoFocus
              placeholder={`Search chats with ${agent.id}`}
              onChange={(event) => setQuery(event.target.value)}
            />
          </div>
          <button
            type="button"
            className="mi bold-dm-new"
            disabled={busy}
            onClick={() => void newChat()}
          >
            <span className="bold-dm-new-plus" aria-hidden="true">
              +
            </span>
            <b>{busy ? 'Starting…' : `New chat with ${agent.id}`}</b>
          </button>
          {chats.map((chat) => (
            <button
              key={chat.id}
              type="button"
              className={`mi bold-dm-history-row ${chatId === chat.id ? 'sel' : ''}`}
              aria-current={chatId === chat.id ? 'true' : undefined}
              onClick={() => pick(chat.id)}
            >
              <span className="bold-dm-history-title">
                <b>{chat.title}</b>
                <span className="small muted">{chatDay(chat.lastMessageAt ?? chat.createdAt)}</span>
              </span>
              <span className="small muted">{chat.summary ?? 'No messages yet'}</span>
            </button>
          ))}
          {state.status === 'success' && chats.length === 0 && (
            <p className="small muted bold-dm-history-empty">
              {query.trim()
                ? `No chats match “${query.trim()}”.`
                : `No earlier chats with ${agent.id} yet.`}
            </p>
          )}
          {state.status === 'error' && (
            <p className="small bold-dm-error" role="alert">
              Couldn’t load earlier chats.
            </p>
          )}
          {error && (
            <p className="small bold-dm-error" role="alert">
              {error}
            </p>
          )}
          <div className="bold-dm-history-foot small muted">
            {agent.id} remembers what matters across chats.{' '}
            <a href={`/b/team/${encodeURIComponent(agent.id)}#agent-memory`}>See its memory</a>
          </div>
        </div>
      )}
    </>
  )
}

/** The promise that a one-to-one is private; a protected label no theme may hide or relabel. */
export function PrivacyNote({ agentId }: { agentId: string }) {
  return (
    <span className="small muted side-privacy bold-dm-privacy" data-protected="inline-flex">
      <LockIcon />
      Only you and {agentId} see this
    </span>
  )
}

const STARTERS = ['What are you working on?', 'What do you need from me?', 'Show me your screen']

function Starters({ onAsk }: { onAsk: (text: string) => void }) {
  return (
    <div className="bold-dm-starters">
      {STARTERS.map((question) => (
        <button
          key={question}
          type="button"
          className="btn sm ghost"
          onClick={() => onAsk(question)}
        >
          {question}
        </button>
      ))}
    </div>
  )
}

function EmptyHome({ agent, onAsk }: { agent: AgentSummary; onAsk: (text: string) => void }) {
  return (
    <div className="bold-dm-empty">
      <AgentGlyph agent={agent} size="lg" decorative />
      <h2>Just you and {agent.id}</h2>
      <p>
        Nothing here reaches the team room unless you share it. {agent.id} keeps working on its jobs
        while you talk.
      </p>
      <Starters onAsk={onAsk} />
    </div>
  )
}

function ShareMenu({
  messageId,
  jobs,
  onClose,
  onShared,
}: {
  messageId: string
  jobs: Job[]
  onClose: () => void
  onShared: (messageId: string) => void
}) {
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)

  async function share(jobId: string) {
    setBusy(jobId)
    setError(null)
    try {
      await shareMessageToJob(messageId, jobId)
      onShared(messageId)
      onClose()
    } catch {
      setError('Couldn’t share it. Try again.')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div
      className="bold-dm-share-menu"
      role="dialog"
      aria-label="Share to the team room"
      data-protected="block"
    >
      <div className="bold-dm-share-head">
        <b>Share to the team room</b>
        <button
          type="button"
          className="icon-btn sm"
          aria-label="Close share menu"
          onClick={onClose}
        >
          <CloseIcon />
        </button>
      </div>
      <p className="small muted">Choose the job that should get a frozen copy of this reply.</p>
      {jobs.length === 0 ? (
        <p className="small muted">The team room has no open jobs yet.</p>
      ) : (
        jobs.map((job) => (
          <button
            key={job.id}
            type="button"
            className="mi"
            disabled={busy !== null}
            onClick={() => void share(job.id)}
          >
            <span className="bold-dm-share-job">
              <b>{job.title}</b>
              <span className="small muted">{job.isDefault ? 'Team room thread' : job.state}</span>
            </span>
            {busy === job.id && <span className="small muted">Sharing…</span>}
          </button>
        ))
      )}
      {error && (
        <p className="small bold-dm-error" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}

function AddSomeone({
  agents,
  agent,
  chat,
  team,
  onClose,
  onMoved,
}: {
  agents: AgentSummary[]
  agent: AgentSummary
  chat: Job
  team: { room: Room; jobs: Job[] } | undefined
  onClose: () => void
  onMoved: (job: Job) => void
}) {
  const [busy, setBusy] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const choices = agents.filter((item) => item.id !== agent.id)

  async function add(target: AgentSummary) {
    if (!team) {
      setError('The team room isn’t ready yet.')
      return
    }
    setBusy(target.id)
    setError(null)
    try {
      onMoved(await moveChatToTeamRoom(team.room.id, chat, target.id))
    } catch {
      setError('Couldn’t start the team chat. Try again.')
    } finally {
      setBusy(null)
    }
  }

  return (
    <div
      className="bold-dm-add"
      role="dialog"
      aria-label="Add someone to this one-to-one"
      data-protected="block"
      data-decision
    >
      <div className="bold-dm-share-head">
        <b>Add someone</b>
        <button
          type="button"
          className="icon-btn sm"
          aria-label="Close Add someone"
          onClick={onClose}
        >
          <CloseIcon />
        </button>
      </div>
      <p>
        A one-to-one has no room for a third. Adding someone starts a new job in the team room with
        this chat referenced, not copied; everyone there sees the frozen summary. This chat stays as
        it is.
      </p>
      <div className="bold-dm-add-list">
        {choices.map((item) => (
          <button
            key={item.id}
            type="button"
            className="btn sm"
            disabled={busy !== null || !team}
            onClick={() => void add(item)}
          >
            <AgentGlyph agent={item} size="xs" bare decorative />
            {busy === item.id ? 'Starting…' : `Add ${item.id}`}
          </button>
        ))}
      </div>
      {error && (
        <p className="small bold-dm-error" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}

function DirectConversation({
  room,
  chat,
  agent,
  agents,
  referenceJobId,
  team,
  onClearReference,
  onCloseSheet,
}: {
  room: Room
  chat: Job
  agent: AgentSummary
  agents: AgentSummary[]
  referenceJobId: string | null
  team: { room: Room; jobs: Job[] } | undefined
  onClearReference: () => void
  onCloseSheet?: (() => void) | undefined
}) {
  const definition = useMemo(() => roomMessagesQuery(room.id, chat.id), [chat.id, room.id])
  const page = useStreamQuery(definition)
  const navigate = useNavigate()
  const [shareFor, setShareFor] = useState<string | null>(null)
  const [shared, setShared] = useState<ReadonlySet<string>>(() => new Set())
  const [adding, setAdding] = useState(false)
  const [starterKey, setStarterKey] = useState(0)
  const [bringing, setBringing] = useState(false)
  const [bringError, setBringError] = useState<string | null>(null)
  const items = page.data?.items ?? []
  const lastAgent = [...items]
    .reverse()
    .find(
      (message) =>
        message.author.kind === 'agent' && !message.streaming && !message.id.startsWith('pending-'),
    )
  const referenceTitle = referenceJobId
    ? (team?.jobs.find((job) => job.id === referenceJobId)?.title ?? 'the earlier chat')
    : null
  const finishedReplies = items.filter(
    (message) => message.author.kind === 'agent' && !message.streaming,
  ).length
  const sessionId = `score-${room.id}-${chat.id}-${agent.id}`

  function prefill(text: string) {
    saveDraft(room.id, text)
    setStarterKey((value) => value + 1)
    requestAnimationFrame(() =>
      document.querySelector<HTMLTextAreaElement>('.bold-dm-composer textarea')?.focus(),
    )
  }

  async function bringIntoNewChat() {
    setBringing(true)
    setBringError(null)
    try {
      const made = await createDirectChat(agent.id, chat.title)
      navigate(boldChatRefLink(agent.id, made.id, chat.id))
    } catch {
      setBringError('Couldn’t start a new chat. Try again.')
    } finally {
      setBringing(false)
    }
  }

  function moved(job: Job) {
    setAdding(false)
    onCloseSheet?.()
    navigate(boldJobLink(job.id))
  }

  return (
    <div className="bold-dm">
      <div className="bold-dm-scroll">
        <div className="bold-dm-thread">
          {chatDay(chat.createdAt) !== 'Today' && (
            <span className="bold-dm-date">{chatDay(chat.createdAt)} · earlier chat</span>
          )}
          {page.status === 'pending' && !page.data && (
            <p className="bold-stream-note" role="status">
              Loading the chat…
            </p>
          )}
          {page.status === 'error' && (
            <p className="bold-stream-note" role="alert">
              Couldn’t load this chat. Try again.
            </p>
          )}
          {page.status === 'success' && items.length === 0 && (
            <div className="bold-dm-welcome">
              <AgentGlyph agent={agent} size="lg" decorative />
              <h2>New chat with {agent.id}</h2>
              <p className="muted">
                Nothing here reaches the team room unless you share it. {agent.id} keeps working on
                its jobs while you talk.
              </p>
              <Starters onAsk={prefill} />
            </div>
          )}
          {items.map((message) => (
            <div
              className="bold-message bold-dm-message"
              key={message.id}
              data-message-id={message.id}
            >
              <MessageItem message={message} agents={agents} />
              {message.id === lastAgent?.id && (
                <div className="bold-dm-msg-actions">
                  {shared.has(message.id) ? (
                    <span className="bold-dm-shared-sent" role="status">
                      Shared to the team room
                    </span>
                  ) : (
                    <button
                      type="button"
                      className="btn sm bold-dm-primary"
                      onClick={() => setShareFor((id) => (id === message.id ? null : message.id))}
                    >
                      Share to the team room
                    </button>
                  )}
                  <button
                    type="button"
                    className="btn sm ghost"
                    disabled={bringing}
                    onClick={() => void bringIntoNewChat()}
                  >
                    {bringing ? 'Starting…' : 'Bring into a new chat'}
                  </button>
                </div>
              )}
              {shareFor === message.id && (
                <ShareMenu
                  messageId={message.id}
                  jobs={team?.jobs ?? []}
                  onClose={() => setShareFor(null)}
                  onShared={(id) => setShared((current) => new Set(current).add(id))}
                />
              )}
            </div>
          ))}
          {bringError && (
            <p className="small bold-dm-error" role="alert">
              {bringError}
            </p>
          )}
          {Object.entries(page.data?.typing ?? {}).map(([agentId, text]) => (
            <p className="bold-dm-typing" key={agentId} role="status">
              <AgentGlyph agent={agent} size="xs" bare decorative />
              <b style={{ color: agentNameColor(agent) }}>{agentId}</b> {text}
            </p>
          ))}
        </div>
      </div>
      <div className="bold-dm-composer">
        {referenceTitle && (
          <span className="bold-dm-ref" style={{ borderColor: agent.style.color }}>
            <HistoryIcon />
            Referring to <b>{referenceTitle}</b>
            <button type="button" aria-label="Remove reference" onClick={onClearReference}>
              <CloseIcon size={12} />
            </button>
          </span>
        )}
        <Composer
          key={`${chat.id}-${starterKey}`}
          roomId={room.id}
          roomName={`${agent.id} privately`}
          agents={[agent]}
          leadAgentId={agent.id}
          jobId={chat.id}
          roomMode
          placeholder={`Message ${agent.id} privately`}
          messagesKey={definition.key}
          references={referenceJobId ? [{ jobId: referenceJobId }] : []}
          onSent={onClearReference}
        />
        <div className="bold-dm-foot">
          <button type="button" className="bold-dm-link" onClick={() => setAdding(true)}>
            Add someone
          </button>
          <span className="bold-dm-context" role="group" aria-label="Context use">
            <ContextMeter
              roomId={room.id}
              agentId={agent.id}
              name={agent.name}
              sessionId={sessionId}
              finishedReplies={finishedReplies}
            />
          </span>
        </div>
        {adding && (
          <AddSomeone
            agents={agents}
            agent={agent}
            chat={chat}
            team={team}
            onClose={() => setAdding(false)}
            onMoved={moved}
          />
        )}
      </div>
    </div>
  )
}

/** The one-to-one body: home (no chats yet), loading, or the selected chat with its composer. */
export function BoldDirect({
  agent,
  agents,
  chatId,
  referenceJobId,
  onClearReference,
  onCloseSheet,
}: {
  agent: AgentSummary
  agents: AgentSummary[]
  chatId: string | null
  referenceJobId: string | null
  onClearReference: () => void
  onCloseSheet?: (() => void) | undefined
}) {
  const definition = useMemo(() => directChatsQuery(agent.id), [agent.id])
  const direct = useStreamQuery(definition)
  const refetch = useStreamQueryRefetch(definition)
  const teamRoom = useBoldTeamRoom()
  const navigate = useNavigate()
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const room = direct.data?.room ?? null
  const chats = direct.data?.chats ?? []
  const chat = chatId ? chats.find((item) => item.id === chatId) : chats[0]
  const team = teamRoom.data

  async function newChat(prompt?: string) {
    setBusy(true)
    setError(null)
    try {
      const made = await createDirectChat(agent.id)
      if (prompt) saveDraft(made.roomId, prompt)
      await refetch()
      navigate(boldChatLink(agent.id, made.id))
    } catch {
      setError('Couldn’t start a chat. Try again.')
    } finally {
      setBusy(false)
    }
  }

  // Opening an agent's home lands in its latest chat (the dock, Search and Team all link to the home).
  useEffect(() => {
    if (chatId !== null || direct.status !== 'success') return
    const latest = direct.data?.chats[0]
    if (latest) navigate(boldChatLink(agent.id, latest.id), { replace: true })
  }, [agent.id, chatId, direct.data?.chats, direct.status, navigate])

  if (direct.status === 'pending' && !direct.data)
    return (
      <p className="bold-stream-note bold-dm-status" role="status">
        Opening your chats with {agent.id}…
      </p>
    )
  if (direct.status === 'error')
    return (
      <p className="bold-stream-note bold-dm-status" role="alert">
        Couldn’t load your chats with {agent.id}. Try again.
      </p>
    )
  if (!room || chats.length === 0)
    return (
      <div className="bold-dm">
        <EmptyHome agent={agent} onAsk={(text) => void newChat(text)} />
        {error && (
          <p className="small bold-dm-error" role="alert">
            {error}
          </p>
        )}
      </div>
    )
  if (!chat)
    return (
      <div className="bold-dm">
        <div className="bold-dm-welcome">
          <AgentGlyph agent={agent} size="lg" decorative />
          <h2>This chat isn’t here any more</h2>
          <p className="muted">Pick an earlier chat to keep talking with {agent.id}.</p>
          <button
            type="button"
            className="btn sm"
            onClick={() => navigate(boldOneToOneLink(agent.id))}
          >
            Back to {agent.id}
          </button>
        </div>
      </div>
    )
  return (
    <DirectConversation
      room={room}
      chat={chat}
      agent={agent}
      agents={agents}
      referenceJobId={referenceJobId}
      team={team}
      onClearReference={onClearReference}
      onCloseSheet={onCloseSheet}
    />
  )
}
