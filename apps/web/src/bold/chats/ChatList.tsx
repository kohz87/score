import { ChatRowEffort } from '../efforts/ChatRowEffort.tsx'
import { useState, type CSSProperties } from 'react'
import { Link, useNavigate } from 'react-router'
import { AgentGlyph } from '../../components/AgentGlyph.tsx'
import { agentMood } from '../bold-agents.ts'
import { NewTeamDialog } from '../room/TeamDialogs.tsx'
import { chatAddress, filterEntries, type ChatEntry, type ChatLists } from './chat-model.ts'
import { PlusIcon } from '../BoldIcons.tsx'
import './chats.css'

const FOLD_KEY = 'score.chats.folded'

/** The fold choice is per device; a blocked or full storage just means the list opens unfolded every time. */
export function readFolded(): boolean {
  try {
    return window.localStorage.getItem(FOLD_KEY) === '1'
  } catch {
    return false
  }
}
export function saveFolded(folded: boolean): void {
  try {
    window.localStorage.setItem(FOLD_KEY, folded ? '1' : '0')
  } catch {
    // Not remembered; the list still folds for this visit.
  }
}

function Tile({ entry, size }: { entry: ChatEntry; size: 'row' | 'rail' }) {
  if (entry.kind === 'direct' && entry.agent)
    return (
      <span className={`bold-chat-avatar is-${size}`} aria-hidden="true">
        <AgentGlyph agent={entry.agent} size="sm" bare decorative mood={agentMood(entry.agent)} />
      </span>
    )
  return (
    <span
      className={`bold-chat-tile is-${size}`}
      aria-hidden="true"
      style={entry.color ? ({ '--chat-color': entry.color } as CSSProperties) : undefined}
    >
      {entry.name.trim().charAt(0).toUpperCase() || '#'}
    </span>
  )
}

function Row({ entry, selected, phone }: { entry: ChatEntry; selected: boolean; phone: boolean }) {
  return (
    <Link
      className={`bold-chat-row${selected ? ' on' : ''}${entry.kind === 'direct' ? ' direct' : ''}`}
      to={chatAddress(entry, phone)}
      aria-current={selected ? 'page' : undefined}
      data-chat-kind={entry.kind}
    >
      <Tile entry={entry} size="row" />
      <span className="bold-chat-copy">
        <span className="bold-chat-top">
          <b>{entry.name}</b>
          {entry.kind === 'direct' && entry.room && entry.agent && (
            <ChatRowEffort roomId={entry.room.id} agentId={entry.agent.id} />
          )}
          {entry.at && <span className="bold-chat-at">{entry.at}</span>}
        </span>
        <span className="bold-chat-line">{entry.line}</span>
      </span>
      {entry.unread > 0 && (
        <span className="bold-unread" aria-label={`${entry.unread} unread`}>
          {entry.unread > 99 ? '99+' : entry.unread}
        </span>
      )}
      {entry.needsYou && (
        <span className="bold-chat-needs" data-protected="inline-flex">
          needs you
        </span>
      )}
    </Link>
  )
}

/**
 * The left column (3.21.0, board 18): groups and directs, newest activity first, with a search box, a "new team room"
 * button and a fold into a rail of tiles. On a phone it is the first screen and takes the whole width.
 */
export function ChatList({
  lists,
  ready,
  selected,
  phone,
  folded,
  onFold,
  foldLocked = false,
}: {
  lists: ChatLists
  ready: boolean
  /** `group:<room id>` or `direct:<agent id>`. */
  selected: string | null
  phone: boolean
  folded: boolean
  onFold: (folded: boolean) => void
  /** The list is folded to make room (the Graph tab on a narrow screen): there is no unfold button then. */
  foldLocked?: boolean
}) {
  const [search, setSearch] = useState('')
  const [making, setMaking] = useState(false)
  const navigate = useNavigate()
  const groups = filterEntries(lists.groups, search)
  const directs = filterEntries(lists.directs, search)
  const isOn = (entry: ChatEntry) => selected === `${entry.kind}:${entry.id}`

  if (folded && !phone)
    return (
      <aside className="bold-chat-list rail" aria-label="Chats, folded">
        {!foldLocked && (
          <button
            type="button"
            className="bold-chat-round"
            aria-label="Show the chat list"
            onClick={() => onFold(false)}
          >
            ›
          </button>
        )}
        {[...lists.groups, ...lists.directs].map((entry) => (
          <Link
            key={`${entry.kind}:${entry.id}`}
            className={`bold-chat-rail-item${isOn(entry) ? ' on' : ''}`}
            to={chatAddress(entry, phone)}
            aria-label={entry.needsYou ? `${entry.name}, needs you` : entry.name}
            aria-current={isOn(entry) ? 'page' : undefined}
            title={entry.name}
            data-protected={entry.needsYou ? 'flex' : undefined}
          >
            <Tile entry={entry} size="rail" />
          </Link>
        ))}
      </aside>
    )

  return (
    <aside className="bold-chat-list" aria-label="Chats">
      {phone ? (
        <div className="bold-chat-phone-head">
          <h1 className="bold-chat-title">Chats</h1>
          <button
            type="button"
            className="bold-chat-round solid"
            aria-label="New team room"
            onClick={() => setMaking(true)}
          >
            <PlusIcon size={18} />
          </button>
        </div>
      ) : (
        <div className="bold-chat-tools">
          <button
            type="button"
            className="bold-chat-round"
            aria-label="Fold the chat list"
            onClick={() => onFold(true)}
          >
            ‹
          </button>
          <input
            type="search"
            className="bold-chat-search"
            aria-label="Search chats"
            placeholder="Search chats"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <button
            type="button"
            className="bold-chat-round solid"
            aria-label="New team room"
            onClick={() => setMaking(true)}
          >
            <PlusIcon size={18} />
          </button>
        </div>
      )}
      <div className="bold-chat-scroll">
        {!ready && <p className="bold-chat-note">Loading your chats…</p>}
        {ready && groups.length === 0 && directs.length === 0 && (
          <p className="bold-chat-note" role="status">
            No chat matches “{search.trim()}”.
          </p>
        )}
        {groups.length > 0 && (
          <section aria-labelledby="chat-groups">
            <h2 id="chat-groups" className="bold-chat-kicker">
              Groups
            </h2>
            {groups.map((entry) => (
              <Row key={entry.id} entry={entry} selected={isOn(entry)} phone={phone} />
            ))}
          </section>
        )}
        {directs.length > 0 && (
          <section aria-labelledby="chat-directs">
            <h2 id="chat-directs" className="bold-chat-kicker">
              Direct
            </h2>
            {directs.map((entry) => (
              <Row key={entry.id} entry={entry} selected={isOn(entry)} phone={phone} />
            ))}
          </section>
        )}
      </div>
      {making && (
        <NewTeamDialog
          onClose={() => setMaking(false)}
          onCreated={(room) => {
            setMaking(false)
            void navigate(`/b?room=${encodeURIComponent(room.id)}`)
          }}
        />
      )}
    </aside>
  )
}
