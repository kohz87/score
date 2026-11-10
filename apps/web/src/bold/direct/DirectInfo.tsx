import { DirectEffortBlock } from '../efforts/DirectEffortBlock.tsx'
import type { AgentSummary, Job } from '@score/contract'
import { useMemo, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { useStreamQuery, useStreamQueryRefetch } from '../../data/query-client.ts'
import { AgentGlyph } from '../../components/AgentGlyph.tsx'
import { useBoldTeamRoom } from '../bold-search-queries.ts'
import { agentDisplayName, agentMood, agentStateLabel } from '../bold-agents.ts'
import { boldAgentWorkspaceLink, boldChatLink, boldJobLink } from '../bold-links.ts'
import { jobDot } from '../room/job-dot.ts'
import { jobStateLabel } from '../room/room-model.ts'
import { useSharedWorkspaces } from '../workspaces-queries.ts'
import { chatDay, currentChat, listedChats, matchesChat } from './direct-model.ts'
import { createDirectChat, directChatsQuery } from './direct-queries.ts'
import { ScreenShortcut, hasScreen } from './DirectHeader.tsx'
import { AddSomeone } from './direct-parts.tsx'
import { DirectAssigned } from './DirectAssigned.tsx'
import { InfoSection } from '../chats/InfoSection.tsx'
import { FilesAndResults } from '../chats/FilesResults.tsx'
import './bold-direct.css'

/**
 * The side panel's Info for a one-to-one (3.22.0): the agent, its workspace and its chats as topics (with the old
 * "Earlier chats" search and New chat), Add someone, and the way to its memory and the Knowledge page.
 */
export function DirectInfo({
  agent,
  agents,
  chatId,
  visible = true,
  onNavigate,
}: {
  agent: AgentSummary
  agents: AgentSummary[]
  chatId: string | null
  /** False while the panel is out of sight (a closed phone sheet or panel): Files and results reads nothing then. */
  visible?: boolean
  /** A link or button here leaves the sheet (the phone closes it). */
  onNavigate?: (() => void) | undefined
}) {
  const definition = useMemo(() => directChatsQuery(agent.id), [agent.id])
  const state = useStreamQuery(definition)
  const roomId = state.data?.room?.id ?? null
  const refetch = useStreamQueryRefetch(definition)
  const navigate = useNavigate()
  const team = useBoldTeamRoom().data
  const room = state.data?.room ?? null
  const workspaces = useSharedWorkspaces(Boolean(room?.workspaceId)).data
  const workspace = room?.workspaceId
    ? workspaces?.find((item) => item.id === room.workspaceId)
    : undefined
  const allChats = state.data?.chats ?? []
  const [query, setQuery] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [adding, setAdding] = useState(false)
  const chats = listedChats(allChats).filter((chat) => matchesChat(chat, query))
  const { current } = currentChat(allChats, chatId)
  const name = agentDisplayName(agent)

  async function newChat() {
    setBusy(true)
    setError(null)
    try {
      const chat = await createDirectChat(agent.id)
      await refetch()
      setQuery('')
      onNavigate?.()
      navigate(boldChatLink(agent.id, chat.id))
    } catch {
      setError('Couldn’t start a chat. Try again.')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className="sidebody bold-chat-info bold-dm-info" aria-label={`${name}, chat info`}>
      {roomId && <DirectEffortBlock agent={agent} roomId={roomId} />}
      <InfoSection kind="agent" headingId="dm-info-agent" title="Agent" summary={name}>
        <ul className="bold-chat-members">
          <li>
            <AgentGlyph agent={agent} size="sm" bare decorative mood={agentMood(agent)} />
            <span>{name}</span>
            <span className="bold-chat-role">{agentStateLabel(agent)}</span>
          </li>
        </ul>
        <p className="bold-chat-note">{agent.role}</p>
        <div className="bold-chat-jobs-actions">
          <Link
            className="btn sm"
            to={`/b/agents/${encodeURIComponent(agent.id)}`}
            onClick={onNavigate}
          >
            Open {name}’s page
          </Link>
          {hasScreen(agent) && <ScreenShortcut agent={agent} />}
        </div>
      </InfoSection>
      <DirectAssigned agent={agent} onNavigate={onNavigate} />
      <InfoSection
        kind="workspace"
        headingId="dm-info-workspace"
        title="Workspace"
        summary={room?.workspaceId ? (workspace?.name ?? room.workspaceId) : 'none'}
      >
        {room?.workspaceId ? (
          <code>{workspace ? `${workspace.name} · ${workspace.path}` : room.workspaceId}</code>
        ) : (
          <p className="bold-chat-note">None set.</p>
        )}
        <Link
          className="bold-chat-knowledge"
          to={boldAgentWorkspaceLink(agent.id)}
          onClick={onNavigate}
        >
          Open {name}’s workspace files
        </Link>
      </InfoSection>
      <FilesAndResults
        jobId={current?.id ?? null}
        agents={agents}
        visible={visible}
        agentIds={[agent.id]}
      />
      <InfoSection
        kind="chats"
        headingId="dm-info-chats"
        title="Chats"
        summary={String(listedChats(allChats).length)}
      >
        <label className="bold-sr-only" htmlFor={`dm-search-${agent.id}`}>
          Search chats
        </label>
        <input
          id={`dm-search-${agent.id}`}
          className="bold-chat-search bold-dm-search"
          type="search"
          value={query}
          placeholder="Search titles and summaries"
          onChange={(event) => setQuery(event.target.value)}
        />
        <button type="button" className="btn sm" disabled={busy} onClick={() => void newChat()}>
          {busy ? 'Starting…' : `New chat with ${name}`}
        </button>
        {chats.length > 0 && (
          <ul className="bold-chat-topics">
            {chats.map((chat: Job) => (
              <li key={chat.id}>
                <Link
                  to={boldChatLink(agent.id, chat.id)}
                  aria-current={current?.id === chat.id ? 'true' : undefined}
                  onClick={onNavigate}
                >
                  {chat.state === 'done' || chat.state === 'closed' ? (
                    <span className="bold-chat-check" role="img" aria-label={jobStateLabel(chat)}>
                      ✓
                    </span>
                  ) : (
                    <span
                      className="bold-job-dot"
                      role="img"
                      aria-label={jobStateLabel(chat)}
                      style={{ background: jobDot(chat.state, chat.needsYou) }}
                    />
                  )}
                  <span className="bold-chat-topic-title">
                    {chat.isDefault ? 'Main chat' : chat.title}
                  </span>
                  <span className="small muted">
                    {chatDay(chat.lastMessageAt ?? chat.createdAt)}
                  </span>
                </Link>
                {chat.summary && (
                  <span className="small muted bold-dm-chat-summary">{chat.summary}</span>
                )}
              </li>
            ))}
          </ul>
        )}
        {state.status === 'success' && chats.length === 0 && (
          <p className="bold-chat-note">
            {query.trim()
              ? `No chats match “${query.trim()}”.`
              : `No earlier chats with ${name} yet.`}
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
        <p className="small muted">
          {name} remembers what matters across chats.{' '}
          <Link to={`/b/agents/${encodeURIComponent(agent.id)}#agent-memory`} onClick={onNavigate}>
            See its memory
          </Link>
        </p>
      </InfoSection>
      {current && (
        <InfoSection kind="add" headingId="dm-info-add" title="Bring someone in">
          <button type="button" className="btn sm" onClick={() => setAdding(true)}>
            Add someone
          </button>
          {adding && (
            <div className="bold-dm-add-slot">
              <AddSomeone
                agents={agents}
                agent={agent}
                chat={current}
                team={team}
                onClose={() => setAdding(false)}
                onMoved={(job) => {
                  setAdding(false)
                  onNavigate?.()
                  navigate(boldJobLink(job.id))
                }}
              />
            </div>
          )}
        </InfoSection>
      )}
      <Link className="bold-chat-knowledge" to="/b/knowledge" onClick={onNavigate}>
        Open Knowledge
      </Link>
    </div>
  )
}
