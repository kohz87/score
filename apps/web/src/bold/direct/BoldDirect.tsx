import type { AgentSummary, Job, Message, Room } from '@score/contract'
import { useEffect, useMemo, useRef, useState, type RefObject } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useNavigate } from 'react-router'
import { AgentGlyph } from '../../components/AgentGlyph.tsx'
import { useStreamQuery, useStreamQueryRefetch } from '../../data/query-client.ts'
import { Composer } from '../../routes/chat/Composer.tsx'
import { ContextMeter } from '../../routes/chat/ContextMeter.tsx'
import { usePendingDeletes } from '../../routes/chat/message-deletion.ts'
import { setShowDeleted, useShowDeleted } from '../../routes/chat/deleted-toggle.ts'
import { saveDraft } from '../../routes/chat/composer-model.ts'
import { useBoldTeamRoom } from '../bold-search-queries.ts'
import { agentDisplayName, agentNameColor } from '../bold-agents.ts'
import { CloseIcon, HistoryIcon, LockIcon } from '../BoldIcons.tsx'
import {
  boldAsideLink,
  boldChatLink,
  boldChatRefLink,
  boldJobLink,
  boldOneToOneLink,
} from '../bold-links.ts'
import {
  directChatsQuery,
  createDirectChat,
  createTeamJob,
  postChatHandOff,
  shareMessageToJob,
} from './direct-queries.ts'
import {
  BoldMessage,
  buildMessageNodes,
  retryableIds,
  type BranchSelection,
} from '../room/BoldMessage.tsx'
import { questionNeedsYou, questionsQuery } from '../../data/question-queries.ts'
import { QuestionCard, QuestionNote, useQuestionAnnouncement } from '../room/QuestionCard.tsx'
import { beginJobUndo } from '../room/job-undo.ts'
import { ChatMenu, ClearChatDialog, DeleteChatDialog } from '../room/RoomMenus.tsx'
import { changeCachedJob, roomMessagesQuery } from '../room/room-queries.ts'
import { useMessageTools } from '../room/use-message-tools.ts'
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

/** A default thread nobody wrote in is plumbing, not a chat: it stays out of the lists. */
function listedChats(chats: readonly Job[]): Job[] {
  return chats.filter((chat) => !(chat.isDefault && chat.messageCount === 0))
}

/**
 * Escape, a press outside, and focus returning to what opened it, for the popover and the two small dialogs. Escape is
 * taken in the capture phase and marked handled, so on a phone the sheet's own Escape (which closes the whole panel)
 * only sees the key when no dialog is open.
 */
function useDialogDismiss(
  ref: RefObject<HTMLElement | null>,
  onClose: () => void,
  focusRef?: RefObject<HTMLElement | null>,
) {
  const close = useRef(onClose)
  useEffect(() => {
    close.current = onClose
  })
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null
    ;(focusRef?.current ?? ref.current)?.focus()
    function onKeyDown(event: KeyboardEvent) {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      event.preventDefault()
      close.current()
    }
    function onPointerDown(event: PointerEvent) {
      const target = event.target as Node
      if (ref.current?.contains(target) || opener?.contains(target)) return
      close.current()
    }
    document.addEventListener('keydown', onKeyDown, true)
    document.addEventListener('pointerdown', onPointerDown)
    return () => {
      document.removeEventListener('keydown', onKeyDown, true)
      document.removeEventListener('pointerdown', onPointerDown)
      if (opener?.isConnected) opener.focus()
    }
  }, [focusRef, ref])
}

function matchesChat(chat: Job, query: string): boolean {
  const needle = query.trim().toLowerCase()
  if (!needle) return true
  return `${chat.title}\n${chat.summary ?? ''}`.toLowerCase().includes(needle)
}

function HistoryPopover({
  agent,
  chatId,
  chats,
  query,
  onQuery,
  busy,
  error,
  loadFailed,
  loaded,
  onPick,
  onNew,
  onClose,
}: {
  agent: AgentSummary
  chatId: string | null
  chats: Job[]
  query: string
  onQuery: (value: string) => void
  busy: boolean
  error: string | null
  loadFailed: boolean
  loaded: boolean
  onPick: (id: string) => void
  onNew: () => void
  onClose: () => void
}) {
  const box = useRef<HTMLDivElement>(null)
  const search = useRef<HTMLInputElement>(null)
  useDialogDismiss(box, onClose, search)
  return (
    <div
      ref={box}
      className="menu bold-dm-history"
      role="dialog"
      aria-label={`Earlier chats with ${agentDisplayName(agent)}`}
    >
      <div className="bold-dm-history-search">
        <HistoryIcon size={15} />
        <label className="bold-sr-only" htmlFor={`dm-history-${agent.id}`}>
          Search chats
        </label>
        <input
          ref={search}
          id={`dm-history-${agent.id}`}
          value={query}
          placeholder="Search titles and summaries"
          onChange={(event) => onQuery(event.target.value)}
        />
      </div>
      <button type="button" className="mi bold-dm-new" disabled={busy} onClick={onNew}>
        <span className="bold-dm-new-plus" aria-hidden="true">
          +
        </span>
        <b>{busy ? 'Starting…' : `New chat with ${agentDisplayName(agent)}`}</b>
      </button>
      {chats.map((chat) => (
        <button
          key={chat.id}
          type="button"
          className={`mi bold-dm-history-row ${chatId === chat.id ? 'sel' : ''}`}
          aria-current={chatId === chat.id ? 'true' : undefined}
          onClick={() => onPick(chat.id)}
        >
          <span className="bold-dm-history-title">
            <b>{chat.title}</b>
            <span className="small muted">{chatDay(chat.lastMessageAt ?? chat.createdAt)}</span>
          </span>
          <span className="small muted">{chat.summary ?? 'No messages yet'}</span>
        </button>
      ))}
      {loaded && chats.length === 0 && (
        <p className="small muted bold-dm-history-empty">
          {query.trim()
            ? `No chats match “${query.trim()}”.`
            : `No earlier chats with ${agentDisplayName(agent)} yet.`}
        </p>
      )}
      {loadFailed && (
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
        {agentDisplayName(agent)} remembers what matters across chats.{' '}
        <a href={`/b/team/${encodeURIComponent(agent.id)}#agent-memory`}>See its memory</a>
      </div>
    </div>
  )
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
  const queryClient = useQueryClient()
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [deleting, setDeleting] = useState<Job | null>(null)
  const [clearing, setClearing] = useState(false)
  const roomId = state.data?.room?.id ?? ''
  const showDeleted = useShowDeleted(roomId)
  const allChats = state.data?.chats ?? []
  const chats = listedChats(allChats).filter((chat) => matchesChat(chat, query))
  // The chat on show: the one in the URL, or the latest when the home is open.
  const shown = chatId ? allChats.find((item) => item.id === chatId) : listedChats(allChats)[0]
  // Delete and Clear act only on a real chat named in the URL, never on the new-chat state (no chat yet).
  const target = chatId ? allChats.find((item) => item.id === chatId) : undefined
  const messagesDefinition = useMemo(
    () => (roomId && target ? roomMessagesQuery(roomId, target.id) : null),
    [roomId, target],
  )

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
      {roomId && shown && (
        <ChatMenu
          showDeleted={showDeleted}
          onToggleDeleted={() => setShowDeleted(roomId, !showDeleted)}
          // A room's own thread follows the room: the server refuses to delete it, so it is cleared instead.
          onDelete={target && !target.isDefault ? () => setDeleting(target) : undefined}
          onClear={target?.isDefault ? () => setClearing(true) : undefined}
        />
      )}
      {clearing && roomId && (
        <ClearChatDialog
          roomId={roomId}
          agentName={agentDisplayName(agent)}
          onClose={() => setClearing(false)}
          onCleared={() => {
            if (messagesDefinition)
              void queryClient.invalidateQueries({ queryKey: messagesDefinition.key })
          }}
        />
      )}
      {deleting && (
        <DeleteChatDialog
          chat={deleting}
          agentName={agentDisplayName(agent)}
          onClose={() => setDeleting(null)}
          onDeleted={() => {
            changeCachedJob(queryClient, deleting, 'delete')
            beginJobUndo(queryClient, deleting)
            setDeleting(null)
            navigate(boldOneToOneLink(agent.id))
          }}
        />
      )}
      {open && (
        <HistoryPopover
          agent={agent}
          chatId={chatId}
          chats={chats}
          query={query}
          onQuery={setQuery}
          busy={busy}
          error={error}
          loadFailed={state.status === 'error'}
          loaded={state.status === 'success'}
          onPick={pick}
          onNew={() => void newChat()}
          onClose={() => {
            setOpen(false)
            setQuery('')
          }}
        />
      )}
    </>
  )
}

/** The promise that a one-to-one is private; a protected label no theme may hide or relabel. */
export function PrivacyNote({ agent }: { agent: Pick<AgentSummary, 'id' | 'name'> }) {
  return (
    <span className="small muted side-privacy bold-dm-privacy" data-protected="inline-flex">
      <LockIcon />
      Only you and {agentDisplayName(agent)} see this
    </span>
  )
}

const STARTERS = ['What are you working on?', 'What do you need from me?', 'Show me your screen']

function Starters({
  onAsk,
  disabled = false,
}: {
  onAsk: (text: string) => void
  disabled?: boolean
}) {
  return (
    <div className="bold-dm-starters">
      {STARTERS.map((question) => (
        <button
          key={question}
          type="button"
          className="btn sm ghost"
          disabled={disabled}
          onClick={() => onAsk(question)}
        >
          {question}
        </button>
      ))}
    </div>
  )
}

function EmptyHome({
  agent,
  onAsk,
  busy,
}: {
  agent: AgentSummary
  onAsk: (text: string) => void
  busy: boolean
}) {
  return (
    <div className="bold-dm-empty">
      <AgentGlyph agent={agent} size="lg" decorative />
      <h2>Just you and {agentDisplayName(agent)}</h2>
      <p>
        Nothing here reaches the team room unless you share it. {agentDisplayName(agent)} keeps
        working on its jobs while you talk.
      </p>
      <Starters onAsk={onAsk} disabled={busy} />
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
  const box = useRef<HTMLDivElement>(null)
  useDialogDismiss(box, onClose)
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
      ref={box}
      tabIndex={-1}
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

/**
 * Adding someone to a one-to-one starts a team-room job, so the dialog says what leaves before anything does: the job's
 * title and the summary that travels with it. A failed hand-off message keeps the job and offers a retry of just the
 * message, never a second job.
 */
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
  team: { room: Room; jobs: Job[] } | null | undefined
  onClose: () => void
  onMoved: (job: Job) => void
}) {
  const box = useRef<HTMLDivElement>(null)
  useDialogDismiss(box, onClose)
  const [target, setTarget] = useState<AgentSummary | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // The job exists once step one worked; a retry only repeats the message.
  const [job, setJob] = useState<Job | null>(null)
  const choices = agents.filter((item) => item.id !== agent.id)
  const title = chat.title || 'New chat'

  async function confirm() {
    if (!team || !target) {
      setError('The team room isn’t ready yet.')
      return
    }
    setBusy(true)
    setError(null)
    let made = job
    try {
      if (!made) {
        made = await createTeamJob(team.room.id, chat)
        setJob(made)
      }
    } catch {
      setError('Couldn’t start the team chat. Try again.')
      setBusy(false)
      return
    }
    try {
      await postChatHandOff(team.room.id, made.id, chat, [agent.id, target.id])
      onMoved(made)
    } catch {
      setError(
        `The job “${made.title}” is in the team room, but the message to ${target.id} didn’t send.`,
      )
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      ref={box}
      tabIndex={-1}
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
      {!target ? (
        <div className="bold-dm-add-list">
          {choices.map((item) => (
            <button
              key={item.id}
              type="button"
              className="btn sm"
              disabled={!team}
              onClick={() => setTarget(item)}
            >
              <AgentGlyph agent={item} size="xs" bare decorative />
              {`Add ${agentDisplayName(item)}`}
            </button>
          ))}
        </div>
      ) : (
        <div className="bold-dm-add-confirm">
          <p>
            <b>What leaves this chat</b>
          </p>
          <p className="small">
            Job in the team room: <b>{title}</b>
          </p>
          <p className="small muted bold-dm-add-summary">
            {chat.summary ? `Summary shared: ${chat.summary}` : 'A summary of this chat is shared.'}
          </p>
          <p className="small muted">
            The first message asks {agentDisplayName(agent)} and {agentDisplayName(target)}; both
            see the summary.
          </p>
          <div className="bold-dm-add-list">
            <button
              type="button"
              className="btn sm bold-dm-primary"
              disabled={busy || !team}
              onClick={() => void confirm()}
            >
              {busy
                ? 'Starting…'
                : job
                  ? `Retry the message to ${target.id}`
                  : `Add ${target.id} and share a summary`}
            </button>
            <button
              type="button"
              className="btn sm ghost"
              disabled={busy}
              onClick={() => {
                setTarget(null)
                setError(null)
              }}
            >
              Back
            </button>
          </div>
        </div>
      )}
      {error && (
        <p className="small bold-dm-error" role="alert">
          {error}
        </p>
      )}
    </div>
  )
}

/** Where the person is "near the bottom" of the thread, so streaming text keeps following them. */
const FOLLOW_SLACK = 80

type OlderState = {
  chatId: string
  cursors: string[]
  pages: Record<string, { items: Message[]; next: string | null }>
}

function OlderPage({
  roomId,
  jobId,
  before,
  onPage,
}: {
  roomId: string
  jobId: string
  before: string
  onPage: (before: string, items: Message[], next: string | null) => void
}) {
  const definition = useMemo(
    () => roomMessagesQuery(roomId, jobId, before),
    [before, jobId, roomId],
  )
  const { data } = useStreamQuery(definition)
  useEffect(() => {
    if (data) onPage(before, data.items, data.nextCursor)
  }, [before, data, onPage])
  return null
}

function ReferenceChip({
  agent,
  title,
  onClear,
}: {
  agent: AgentSummary
  title: string
  onClear: () => void
}) {
  return (
    <span className="bold-dm-ref" style={{ borderColor: agent.style.color }}>
      <HistoryIcon />
      Referring to <b>{title}</b>
      <button type="button" aria-label="Remove reference" onClick={onClear}>
        <CloseIcon size={12} />
      </button>
    </span>
  )
}

/**
 * "Take it aside" and "Bring into a new chat" open here: the chat is made when the first message is sent (or an empty
 * chat with the same title is reused), so a look that goes nowhere leaves nothing behind in Earlier chats.
 */
function AsideStart({
  room,
  chats,
  agent,
  referenceJobId,
  referenceTitle,
  onClearReference,
}: {
  room: Room
  chats: Job[]
  agent: AgentSummary
  referenceJobId: string
  referenceTitle: string
  onClearReference: () => void
}) {
  const navigate = useNavigate()
  const made = useRef<string | null>(null)
  const [starterKey, setStarterKey] = useState(0)
  const draftScope = `${room.id}:aside:${referenceJobId}`

  async function resolveJob(): Promise<string> {
    if (made.current) return made.current
    const empty = chats.find((chat) => chat.title === referenceTitle && chat.messageCount === 0)
    if (empty) {
      made.current = empty.id
      return empty.id
    }
    const job = await createDirectChat(agent.id, referenceTitle)
    made.current = job.id
    return job.id
  }

  function prefill(text: string) {
    saveDraft(draftScope, text)
    setStarterKey((value) => value + 1)
    requestAnimationFrame(() =>
      document.querySelector<HTMLTextAreaElement>('.bold-dm-composer textarea')?.focus(),
    )
  }

  return (
    <div className="bold-dm">
      <div className="bold-dm-scroll">
        <div className="bold-dm-thread">
          <div className="bold-dm-welcome">
            <AgentGlyph agent={agent} size="lg" decorative />
            <h2>New chat with {agentDisplayName(agent)}</h2>
            <p className="muted">
              Nothing here reaches the team room unless you share it. {agentDisplayName(agent)} sees
              a frozen summary of “{referenceTitle}”, not the whole thread.
            </p>
            <Starters onAsk={prefill} />
          </div>
        </div>
      </div>
      <div className="bold-dm-composer">
        <ReferenceChip agent={agent} title={referenceTitle} onClear={onClearReference} />
        <Composer
          key={`aside-${referenceJobId}-${starterKey}`}
          roomId={room.id}
          roomName={`${agentDisplayName(agent)} privately`}
          agents={[agent]}
          leadAgentId={agent.id}
          roomMode
          placeholder={`Message ${agentDisplayName(agent)} privately`}
          messagesKey={roomMessagesQuery(room.id, null).key}
          draftScope={draftScope}
          references={[{ jobId: referenceJobId }]}
          resolveJob={resolveJob}
          onSent={() => {
            if (made.current) navigate(boldChatLink(agent.id, made.current), { replace: true })
          }}
        />
      </div>
    </div>
  )
}

function DirectConversation({
  room,
  chat,
  agent,
  agents,
  referenceJobId,
  referenceTitle,
  team,
  onClearReference,
  onCloseSheet,
}: {
  room: Room
  chat: Job
  agent: AgentSummary
  agents: AgentSummary[]
  referenceJobId: string | null
  referenceTitle: string | null
  team: { room: Room; jobs: Job[] } | null | undefined
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
  const [older, setOlder] = useState<OlderState>({ chatId: chat.id, cursors: [], pages: {} })
  const ownOlder: OlderState =
    older.chatId === chat.id ? older : { chatId: chat.id, cursors: [], pages: {} }
  const draftScope = `${room.id}:${chat.id}`
  const tools = useMessageTools(room.id)
  const showDeleted = useShowDeleted(room.id)
  const hidden = usePendingDeletes().hidden
  const [view, setView] = useState<(BranchSelection & { chatId: string }) | null>(null)
  // The page arrives newest first; the thread reads oldest to newest.
  const everyMessage = useMemo(() => {
    const byId = new Map<string, Message>()
    for (const message of page.data?.items ?? []) byId.set(message.id, message)
    for (const entry of Object.values(ownOlder.pages))
      for (const message of entry.items) if (!byId.has(message.id)) byId.set(message.id, message)
    return [...byId.values()].sort(
      (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
    )
  }, [ownOlder.pages, page.data?.items])
  const retryable = useMemo(() => retryableIds(everyMessage), [everyMessage])
  const items = useMemo(
    () => everyMessage.filter((message) => !hidden.has(message.id)),
    [everyMessage, hidden],
  )
  const lastCursor = ownOlder.cursors.at(-1)
  const nextCursor =
    lastCursor === undefined
      ? (page.data?.nextCursor ?? null)
      : (ownOlder.pages[lastCursor]?.next ?? null)
  const collectOlder = useMemo(
    () => (before: string, pageItems: Message[], next: string | null) =>
      setOlder((current) => {
        const known = current.pages[before]
        if (known && known.items === pageItems && known.next === next) return current
        return { ...current, pages: { ...current.pages, [before]: { items: pageItems, next } } }
      }),
    [],
  )

  const scroller = useRef<HTMLDivElement>(null)
  const following = useRef(true)
  const last = items.at(-1)
  const shownChat = useRef<string | null>(null)
  useEffect(() => {
    const element = scroller.current
    if (!element) return
    // A different chat always starts at its end; the same chat only follows a reader who is still at the end.
    const changed = shownChat.current !== chat.id
    shownChat.current = chat.id
    if (changed) following.current = true
    if (following.current) element.scrollTop = element.scrollHeight
  }, [chat.id, items.length, last])
  const lastAgent = [...items]
    .reverse()
    .find(
      (message) =>
        message.author.kind === 'agent' && !message.streaming && !message.id.startsWith('pending-'),
    )
  const finishedReplies = items.filter(
    (message) => message.author.kind === 'agent' && !message.streaming,
  ).length
  // This agent's questions in this one-to-one room (decision 128): the open ones are cards in the thread, the ended
  // ones muted lines where they were asked.
  const questionList = useStreamQuery(questionsQuery)
  const roomQuestionsAll = (questionList.data ?? []).filter(
    (question) => question.roomId === room.id && question.agentId === agent.id,
  )
  const pendingQuestions = roomQuestionsAll
    .filter(questionNeedsYou)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
  const questionNotes = roomQuestionsAll
    .filter((question) => !questionNeedsYou(question))
    .filter((question) => question.jobId === null || question.jobId === chat.id)
    .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
    .map((question) => ({
      id: question.id,
      at: question.createdAt,
      node: <QuestionNote question={question} agents={agents} />,
    }))
  const questionAnnouncement = useQuestionAnnouncement(
    pendingQuestions,
    questionList.status === 'success',
    agents,
  )
  const sessionId = `score-${room.id}-${chat.id}-${agent.id}`

  function prefill(text: string) {
    saveDraft(draftScope, text)
    setStarterKey((value) => value + 1)
    requestAnimationFrame(() =>
      document.querySelector<HTMLTextAreaElement>('.bold-dm-composer textarea')?.focus(),
    )
  }

  function bringIntoNewChat() {
    setBringing(true)
    navigate(boldAsideLink(agent.id, chat.id))
  }

  function moved(job: Job) {
    setAdding(false)
    onCloseSheet?.()
    navigate(boldJobLink(job.id))
  }

  return (
    <div className="bold-dm">
      <div
        className="bold-dm-scroll"
        ref={scroller}
        onScroll={(event) => {
          const el = event.currentTarget
          following.current = el.scrollHeight - el.scrollTop - el.clientHeight < FOLLOW_SLACK
        }}
      >
        <div className="bold-dm-thread">
          {ownOlder.cursors.map((before) => (
            <OlderPage
              key={before}
              roomId={room.id}
              jobId={chat.id}
              before={before}
              onPage={collectOlder}
            />
          ))}
          {chatDay(chat.createdAt) !== 'Today' && (
            <span className="bold-dm-date">{chatDay(chat.createdAt)} · earlier chat</span>
          )}
          {page.status === 'success' && nextCursor && (
            <button
              type="button"
              className="btn sm ghost bold-dm-load"
              onClick={() => {
                following.current = false
                setOlder((current) => {
                  const base =
                    current.chatId === chat.id
                      ? current
                      : { chatId: chat.id, cursors: [], pages: {} }
                  return base.cursors.includes(nextCursor)
                    ? base
                    : { ...base, cursors: [...base.cursors, nextCursor] }
                })
              }}
            >
              Load earlier
            </button>
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
              <h2>New chat with {agentDisplayName(agent)}</h2>
              <p className="muted">
                Nothing here reaches the team room unless you share it. {agentDisplayName(agent)}{' '}
                keeps working on its jobs while you talk.
              </p>
              <Starters onAsk={prefill} />
            </div>
          )}
          {
            buildMessageNodes({
              items,
              versions: tools.versions,
              agents,
              showDeleted,
              branch: view?.chatId === chat.id ? view : null,
              onlyJobId: chat.id,
              notes: {
                items: questionNotes,
                used: new Set<string>(),
                tail: true,
              },
              onBranchSelect: (messageId, version) =>
                setView(version ? { messageId, version, chatId: chat.id } : null),
              renderMessage: (message) => (
                <BoldMessage
                  key={message.id}
                  message={message}
                  agents={agents}
                  versions={tools.versions}
                  onView={(version) => setView({ messageId: message.id, version, chatId: chat.id })}
                  pinned={tools.isPinned(message.id)}
                  pinBusy={tools.pinBusy === message.id}
                  onTogglePin={() => void tools.togglePin(message.id)}
                  className="bold-dm-message"
                  canRetry={retryable.has(message.id)}
                >
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
                          onClick={() =>
                            setShareFor((id) => (id === message.id ? null : message.id))
                          }
                        >
                          Share to the team room
                        </button>
                      )}
                      <button
                        type="button"
                        className="btn sm ghost"
                        disabled={bringing}
                        onClick={bringIntoNewChat}
                      >
                        {bringing ? 'Opening…' : 'Bring into a new chat'}
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
                </BoldMessage>
              ),
            }).nodes
          }
          {tools.pinError && (
            <p className="bold-stream-note" role="alert">
              {tools.pinError}
            </p>
          )}
          <span className="bold-sr-only" role="status">
            {questionAnnouncement}
          </span>
          {pendingQuestions.map((question) => (
            <QuestionCard key={question.id} question={question} agent={agent} />
          ))}
          {Object.entries(page.data?.typing ?? {}).map(([agentId, text]) => (
            <p className="bold-dm-typing" key={agentId} role="status">
              <AgentGlyph
                agent={agent}
                size="xs"
                bare
                decorative
                mood={text ? 'working' : 'thinking'}
              />
              <b style={{ color: agentNameColor(agent) }}>{agentId}</b> {text}
            </p>
          ))}
        </div>
      </div>
      <div className="bold-dm-composer">
        {referenceJobId && referenceTitle && (
          <ReferenceChip agent={agent} title={referenceTitle} onClear={onClearReference} />
        )}
        <Composer
          key={`${chat.id}-${starterKey}`}
          roomId={room.id}
          roomName={`${agentDisplayName(agent)} privately`}
          agents={[agent]}
          leadAgentId={agent.id}
          jobId={chat.id}
          roomMode
          placeholder={`Message ${agentDisplayName(agent)} privately`}
          messagesKey={definition.key}
          draftScope={draftScope}
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
              // A direct room's default thread runs in the room's own session; every other chat has its job session.
              sessionId={chat.isDefault ? undefined : sessionId}
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

/** The one-to-one body: home (no chats yet), loading, a first message to a new chat, or the selected chat. */
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
  const allChats = direct.data?.chats ?? []
  const chats = listedChats(allChats)
  const chat = chatId ? allChats.find((item) => item.id === chatId) : chats[0]
  const team = teamRoom.data
  // A new chat that starts from a reference opens empty and is only made when its first message is sent.
  const aside = chatId === null && referenceJobId !== null
  const referenceTitle = referenceJobId
    ? (team?.jobs.find((job) => job.id === referenceJobId)?.title ??
      allChats.find((item) => item.id === referenceJobId)?.title ??
      'the earlier chat')
    : null

  async function newChat(prompt?: string) {
    setBusy(true)
    setError(null)
    try {
      const made = await createDirectChat(agent.id)
      if (prompt) saveDraft(`${made.roomId}:${made.id}`, prompt)
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
    if (chatId !== null || aside || direct.status !== 'success') return
    const latest = listedChats(direct.data?.chats ?? [])[0]
    if (latest) navigate(boldChatLink(agent.id, latest.id), { replace: true })
  }, [agent.id, aside, chatId, direct.data?.chats, direct.status, navigate])

  // An agent with no chat room yet has nowhere to wait: its first chat is made now, already referring to the job.
  const starting = useRef(false)
  const needsRoom = aside && direct.status === 'success' && !room && referenceTitle !== null
  useEffect(() => {
    if (!needsRoom || starting.current || !referenceJobId || !referenceTitle) return
    starting.current = true
    createDirectChat(agent.id, referenceTitle)
      .then((made) =>
        navigate(boldChatRefLink(agent.id, made.id, referenceJobId), { replace: true }),
      )
      .catch(() => {
        starting.current = false
        setError('Couldn’t start a chat. Try again.')
      })
  }, [agent.id, needsRoom, navigate, referenceJobId, referenceTitle])

  if (direct.status === 'pending' && !direct.data)
    return (
      <p className="bold-stream-note bold-dm-status" role="status">
        Opening your chats with {agentDisplayName(agent)}…
      </p>
    )
  if (direct.status === 'error')
    return (
      <p className="bold-stream-note bold-dm-status" role="alert">
        Couldn’t load your chats with {agentDisplayName(agent)}. Try again.
      </p>
    )
  if (aside && room && referenceJobId && referenceTitle)
    return (
      <AsideStart
        room={room}
        chats={allChats}
        agent={agent}
        referenceJobId={referenceJobId}
        referenceTitle={referenceTitle}
        onClearReference={onClearReference}
      />
    )
  if (!room || chats.length === 0)
    return (
      <div className="bold-dm">
        <EmptyHome agent={agent} busy={busy} onAsk={(text) => void newChat(text)} />
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
          <p className="muted">
            Pick an earlier chat to keep talking with {agentDisplayName(agent)}.
          </p>
          <button
            type="button"
            className="btn sm"
            onClick={() => navigate(boldOneToOneLink(agent.id))}
          >
            Back to {agentDisplayName(agent)}
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
      referenceTitle={referenceTitle}
      team={team}
      onClearReference={onClearReference}
      onCloseSheet={onCloseSheet}
    />
  )
}
