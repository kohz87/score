import { JobSchema, type AgentSummary, type Job, type Room } from '@score/contract'
import { useQueryClient } from '@tanstack/react-query'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type RefObject,
} from 'react'
import { useLocation, useNavigate, useSearchParams } from 'react-router'
import { AgentGlyph } from '../../components/AgentGlyph.tsx'
import { apiFetch } from '../../data/api.ts'
import { newId } from '../../data/ids.ts'
import { useStreamQuery, useStreamQueryRefetch } from '../../data/query-client.ts'
import { Composer } from '../../routes/chat/Composer.tsx'
import { saveDraft } from '../../routes/chat/composer-model.ts'
import { setShowDeleted, useShowDeleted } from '../../routes/chat/deleted-toggle.ts'
import '../../routes/chat/chat.css'
import { agentDisplayName } from '../bold-agents.ts'
import { useBoldTeamRoom } from '../bold-search-queries.ts'
import { boldChatLink, boldChatRefLink, boldOneToOneLink, boldAsideLink } from '../bold-links.ts'
import { ContextBar } from '../room/ContextBar.tsx'
import { useFollowEnd } from '../room/follow-end.ts'
import { beginJobUndo } from '../room/job-undo.ts'
import { ChatMenu, ClearChatDialog, DeleteChatDialog } from '../room/RoomMenus.tsx'
import { RoomMessageStream } from '../room/RoomMessageStream.tsx'
import { RoomRequests } from '../room/RoomRequests.tsx'
import { changeCachedJob, roomChatMessagesQuery } from '../room/room-queries.ts'
import type { SystemLine } from '../room/topic-divider.tsx'
import { useTopicCommands } from '../room/topic-commands.ts'
import '../room/bold-room.css'
import { DirectBar, DirectPhoneBar } from './DirectHeader.tsx'
import { currentChat } from './direct-model.ts'
import { createDirectChat, directChatsQuery } from './direct-queries.ts'
import { ReferenceChip, ShareMenu, Starters } from './direct-parts.tsx'
import './bold-direct.css'

/** Only these topic commands make sense in a one-to-one: no owner, members or room workspace to change. */
const DIRECT_COMMANDS = new Set(['new', 'rename', 'done', 'reopen'])

function Welcome({
  agent,
  title,
  onAsk,
  busy = false,
}: {
  agent: AgentSummary
  title?: string
  onAsk: (text: string) => void
  busy?: boolean
}) {
  return (
    <div className="bold-dm-welcome">
      <AgentGlyph agent={agent} size="lg" decorative />
      <h2>{title ?? `Just you and ${agentDisplayName(agent)}`}</h2>
      <p className="muted">
        Nothing here reaches the team room unless you share it. {agentDisplayName(agent)} keeps
        working on its jobs while you talk.
      </p>
      <Starters onAsk={onAsk} disabled={busy} />
    </div>
  )
}

type Props = {
  agent: AgentSummary
  agents: AgentSummary[]
  phone: boolean
  infoOpen: boolean
  onToggleInfo: () => void
  onChatInfo: () => void
  infoRef?: RefObject<HTMLButtonElement | null> | undefined
  infoExpanded?: boolean | undefined
  onBackToChats: () => void
}

/**
 * A one-to-one in the chat view (3.22.0). The agent's chats are the topics of one conversation, read together with the
 * group chat's merged stream; the header, composer with its `/` palette and the context bar are the group chat's.
 */
export function DirectChat(props: Props) {
  const { agent } = props
  const definition = useMemo(() => directChatsQuery(agent.id), [agent.id])
  const direct = useStreamQuery(definition)
  const room = direct.data?.room ?? null
  const bar = (menu?: ReactNode, topic?: string) =>
    props.phone ? (
      <DirectPhoneBar
        agent={agent}
        topic={topic}
        menu={menu}
        infoRef={props.infoRef}
        infoExpanded={props.infoExpanded}
        onBack={props.onBackToChats}
        onInfo={props.onChatInfo}
      />
    ) : (
      <DirectBar
        agent={agent}
        menu={menu}
        infoOpen={props.infoOpen}
        onToggleInfo={props.onToggleInfo}
      />
    )
  if (direct.status === 'pending' && !direct.data)
    return (
      <>
        {bar()}
        <p className="bold-stream-note bold-dm-status" role="status">
          Opening your chats with {agentDisplayName(agent)}…
        </p>
      </>
    )
  if (direct.status === 'error')
    return (
      <>
        {bar()}
        <p className="bold-stream-note bold-dm-status" role="alert">
          Couldn’t load your chats with {agentDisplayName(agent)}. Try again.
        </p>
      </>
    )
  if (!room) return <NoRoomYet {...props} bar={bar()} />
  return <LoadedDirect key={room.id} {...props} room={room} chats={direct.data?.chats ?? []} />
}

/**
 * An agent with no direct room yet. The first chat is made when the person picks a starter (its text becomes the draft),
 * or at once when "Take it aside" brought a reference, so a look that goes nowhere leaves nothing behind.
 */
function NoRoomYet({ agent, bar }: Props & { bar: ReactNode }) {
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const refetch = useStreamQueryRefetch(useMemo(() => directChatsQuery(agent.id), [agent.id]))
  const team = useBoldTeamRoom().data
  const referenceJobId = params.get('ref')
  const referenceTitle = referenceJobId
    ? (team?.jobs.find((job) => job.id === referenceJobId)?.title ?? 'the earlier chat')
    : null
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function start(prompt?: string, title?: string) {
    setBusy(true)
    setError(null)
    try {
      const made = await createDirectChat(agent.id, title)
      if (prompt) saveDraft(made.roomId, prompt)
      await refetch()
      navigate(
        referenceJobId
          ? boldChatRefLink(agent.id, made.id, referenceJobId)
          : boldChatLink(agent.id, made.id),
        { replace: true },
      )
    } catch {
      setError('Couldn’t start a chat. Try again.')
    } finally {
      setBusy(false)
    }
  }

  const starting = useRef(false)
  useEffect(() => {
    if (!referenceTitle || starting.current) return
    starting.current = true
    createDirectChat(agent.id, referenceTitle)
      .then((made) => {
        navigate(boldChatRefLink(agent.id, made.id, referenceJobId!), { replace: true })
      })
      .catch(() => {
        starting.current = false
        setError('Couldn’t start a chat. Try again.')
      })
  }, [agent.id, navigate, referenceJobId, referenceTitle])

  return (
    <>
      {bar}
      <div className="stream">
        <Welcome agent={agent} busy={busy} onAsk={(text) => void start(text)} />
        {error && (
          <p className="small bold-dm-error" role="alert">
            {error}
          </p>
        )}
      </div>
    </>
  )
}

function LoadedDirect({
  agent,
  agents,
  phone,
  infoOpen,
  onToggleInfo,
  onChatInfo,
  infoRef,
  infoExpanded,
  onBackToChats,
  room,
  chats,
}: Props & { room: Room; chats: Job[] }) {
  const [params, setParams] = useSearchParams()
  const location = useLocation()
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const team = useBoldTeamRoom().data
  const chatId = params.get('chat')
  const referenceJobId = params.get('ref')
  const seek = params.get('message')
  const command = params.get('command')
  const { picked, current } = currentChat(chats, chatId)
  const defaultJobId = chats.find((chat) => chat.isDefault)?.id ?? null
  // "Take it aside" without a chat yet: the first message makes one.
  const aside = chatId === null && referenceJobId !== null
  const referenceTitle = referenceJobId
    ? (team?.jobs.find((job) => job.id === referenceJobId)?.title ??
      chats.find((chat) => chat.id === referenceJobId)?.title ??
      'the earlier chat')
    : null
  const showDeleted = useShowDeleted(room.id)
  const streamRef = useFollowEnd(`${room.id}:direct`, seek !== null)
  const [systemLines, setSystemLines] = useState<SystemLine[]>([])
  const [composerKey, setComposerKey] = useState(0)
  const [shareFor, setShareFor] = useState<string | null>(null)
  const [shared, setShared] = useState<ReadonlySet<string>>(() => new Set())
  const [deleting, setDeleting] = useState<Job | null>(null)
  const [clearing, setClearing] = useState(false)
  const made = useRef<string | null>(null)

  const baseMessagesDefinition = useMemo(
    () => roomChatMessagesQuery(room.id, null, defaultJobId),
    [defaultJobId, room.id],
  )
  const composerJobId = !aside && current && !current.isDefault ? current.id : null
  const draftScope = aside ? `${room.id}:aside:${referenceJobId}` : room.id

  const setChat = useCallback(
    (jobId: string | null) => {
      const next = new URLSearchParams(params)
      if (jobId) next.set('chat', jobId)
      else next.delete('chat')
      next.delete('message')
      setParams(next, { replace: true, state: location.state })
    },
    [location.state, params, setParams],
  )
  const clearReference = useCallback(() => {
    if (!params.has('ref')) return
    const next = new URLSearchParams(params)
    next.delete('ref')
    setParams(next, { replace: true, state: location.state })
  }, [location.state, params, setParams])
  const clearSeek = useCallback(() => {
    if (!params.has('message')) return
    const next = new URLSearchParams(params)
    next.delete('message')
    setParams(next, { replace: true, state: location.state })
  }, [location.state, params, setParams])

  const say = (text: string) =>
    setSystemLines((lines) => [...lines, { id: newId(), at: new Date().toISOString(), text }])
  const base = useTopicCommands({ room, agents, jobs: chats, current, pick: setChat, say })
  const topicCommands = {
    items: base.items
      .filter((item) => DIRECT_COMMANDS.has(item.name))
      .map((item) =>
        item.name === 'new'
          ? {
              ...item,
              usage: '/new [title]',
              description: `Start a new chat with ${agentDisplayName(agent)}`,
            }
          : item,
      ),
    run: async (name: string, args: string) => {
      if (name !== 'new') return base.run(name, args)
      // A one-to-one's new chat comes from the agent route (it is called "New chat" when no title is given).
      const chat = await createDirectChat(agent.id, args.trim().slice(0, 200) || undefined)
      changeCachedJob(queryClient, chat, 'upsert')
      setChat(chat.id)
      say(`You started the chat “${chat.title}”`)
    },
  }

  function prefill(text: string) {
    saveDraft(draftScope, text)
    setComposerKey((value) => value + 1)
    requestAnimationFrame(() =>
      document.querySelector<HTMLTextAreaElement>('.bold-room-composer textarea')?.focus(),
    )
  }

  // The chat is made when the first message is sent (or an empty chat with the same title is reused), so a look that
  // goes nowhere leaves nothing behind in the chat list.
  async function resolveJob(): Promise<string> {
    if (made.current) return made.current
    const empty = chats.find((chat) => chat.title === referenceTitle && chat.messageCount === 0)
    if (empty) {
      made.current = empty.id
      return empty.id
    }
    const job = await createDirectChat(agent.id, referenceTitle ?? undefined)
    made.current = job.id
    return job.id
  }

  async function reopenForComposer(jobId: string) {
    const reopened = JobSchema.parse(
      await apiFetch(`jobs/${encodeURIComponent(jobId)}/reopen`, {
        method: 'POST',
        headers: { 'Idempotency-Key': newId() },
        body: '{}',
      }),
    )
    changeCachedJob(queryClient, reopened, 'upsert')
  }

  // The composer writes its optimistic message into this page, so the welcome gives way the moment something is sent.
  const baseMessages = useStreamQuery(baseMessagesDefinition)
  const empty =
    !showDeleted &&
    !aside &&
    chats.every((chat) => chat.isDefault) &&
    baseMessages.status === 'success' &&
    (baseMessages.data?.items.length ?? 0) === 0
  const target = current && !current.isDefault ? current : undefined
  const mainChat = current?.isDefault ? current : undefined
  const missing = chatId !== null && !picked

  const menu = (
    <ChatMenu
      showDeleted={showDeleted}
      onToggleDeleted={() => setShowDeleted(room.id, !showDeleted)}
      // A room's own thread follows the room: the server refuses to delete it, so it is cleared instead.
      onDelete={target ? () => setDeleting(target) : undefined}
      onClear={mainChat ? () => setClearing(true) : undefined}
    />
  )

  return (
    <>
      {phone ? (
        <DirectPhoneBar
          agent={agent}
          topic={target?.title}
          menu={menu}
          infoRef={infoRef}
          infoExpanded={infoExpanded}
          onBack={onBackToChats}
          onInfo={onChatInfo}
        />
      ) : (
        <DirectBar agent={agent} menu={menu} infoOpen={infoOpen} onToggleInfo={onToggleInfo} />
      )}
      {missing && (
        <p className="bold-stream-note" role="status">
          That chat isn’t here any more.
        </p>
      )}
      <RoomRequests roomId={room.id} jobs={chats} agents={agents} selectedJob="all" />
      {empty ? (
        <div className="stream">
          <Welcome agent={agent} onAsk={prefill} />
        </div>
      ) : (
        <div className="stream" id="bold-room-stream" ref={streamRef}>
          {aside && (
            <Welcome
              agent={agent}
              title={`New chat with ${agentDisplayName(agent)}`}
              onAsk={prefill}
            />
          )}
          <RoomMessageStream
            roomId={room.id}
            jobs={chats}
            agents={agents}
            showDeleted={showDeleted}
            seek={seek}
            focusTopic={picked?.id ?? null}
            systemLines={systemLines}
            onSeeked={clearSeek}
            messageExtras={(message, { lastReply }) => {
              if (message.author.kind !== 'agent' || message.streaming) return undefined
              if (message.id.startsWith('pending-')) return undefined
              const name = agentDisplayName(agent)
              return {
                actions: (
                  <>
                    {shared.has(message.id) ? (
                      <span className="bold-dm-shared-sent" role="status">
                        Shared to the team room
                      </span>
                    ) : (
                      <button
                        type="button"
                        className="bold-act"
                        aria-label={`Share message from ${name} to the team room`}
                        aria-expanded={shareFor === message.id}
                        onClick={() => setShareFor((id) => (id === message.id ? null : message.id))}
                      >
                        Share to the team room
                      </button>
                    )}
                    {lastReply && message.jobId && (
                      <button
                        type="button"
                        className="bold-act"
                        onClick={() => navigate(boldAsideLink(agent.id, message.jobId!))}
                      >
                        Bring into a new chat
                      </button>
                    )}
                  </>
                ),
                below:
                  shareFor === message.id ? (
                    <ShareMenu
                      messageId={message.id}
                      jobs={team?.jobs ?? []}
                      onClose={() => setShareFor(null)}
                      onShared={(id) => setShared((all) => new Set(all).add(id))}
                    />
                  ) : undefined,
              }
            }}
          />
        </div>
      )}
      <div className="bold-room-composer bold-dm-composer">
        {referenceJobId && referenceTitle && (
          <ReferenceChip agent={agent} title={referenceTitle} onClear={clearReference} />
        )}
        <Composer
          key={`${composerKey}-${command ?? ''}-${aside ? 'aside' : 'chat'}`}
          roomId={room.id}
          roomName={`${agentDisplayName(agent)} privately`}
          agents={[agent]}
          offered={[agent]}
          leadAgentId={agent.id}
          jobId={composerJobId}
          roomMode
          toLabel={`To: ${agentDisplayName(agent)}`}
          placeholder={`Message ${agentDisplayName(agent)} privately`}
          messagesKey={baseMessagesDefinition.key}
          draftScope={draftScope}
          initialText={command ? `/${command} ` : undefined}
          references={referenceJobId ? [{ jobId: referenceJobId }] : []}
          resolveJob={aside ? resolveJob : undefined}
          topicCommands={topicCommands}
          footer={({ to, subject, finishedReplies, compactSignal, compactSubject }) => (
            <ContextBar
              finishedReplies={finishedReplies}
              compactSignal={compactSignal}
              compactSubject={compactSubject}
              roomId={room.id}
              to={to}
              subjectId={subject ?? agent.id}
              agents={[agent]}
              ownerId={null}
              topic={aside ? undefined : current}
            />
          )}
          onClosedJob={reopenForComposer}
          onSent={() => {
            if (aside && made.current) {
              navigate(boldChatLink(agent.id, made.current), { replace: true })
              return
            }
            clearReference()
            clearSeek()
          }}
        />
      </div>
      {clearing && (
        <ClearChatDialog
          roomId={room.id}
          agentName={agentDisplayName(agent)}
          onClose={() => setClearing(false)}
          onCleared={() =>
            void queryClient.invalidateQueries({
              queryKey: baseMessagesDefinition.key.slice(0, 3),
            })
          }
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
    </>
  )
}
