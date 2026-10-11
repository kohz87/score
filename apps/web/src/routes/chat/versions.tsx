import {
  RoomVersionDetailSchema,
  type AgentSummary,
  type Message,
  type RoomVersion,
} from '@score/contract'
import { useQuery } from '@tanstack/react-query'
import { useEffect, useRef, useState, type KeyboardEvent, type ReactNode } from 'react'
import { apiFetch } from '../../data/api.ts'
import { MessageItem } from './MessageItem.tsx'
import { startEdit } from './message-edit.ts'

/**
 * Message versions like ChatGPT / Open WebUI (PLAN 5.35). All edits of one message form a chain; the current message
 * carries a compact `‹ 2 / 3 ›` control and switching shows an older version of that message and everything that
 * followed it, read-only, in place of the later messages.
 */

/** The older versions behind a message, oldest first: the edits that led to it ("1 / 3" and "2 / 3" before "3 / 3"). */
export function versionChain(messageId: string, versions: RoomVersion[]): RoomVersion[] {
  const chain: RoomVersion[] = []
  let at = versions.find((item) => item.mode === 'edit' && item.replacedBy === messageId)
  while (at && chain.length < 1000 && !chain.includes(at)) {
    chain.unshift(at)
    const anchor: string = at.anchorId
    at = versions.find((item) => item.mode === 'edit' && item.replacedBy === anchor)
  }
  return chain
}

/** Where focus should land after a switch, because the control that was pressed is replaced. */
let pendingFocus: string | null = null

/** The `‹ n / count ›` control. Disabled ends stay focusable (aria-disabled) so the arrow keys never lose focus. */
export function VersionControl({
  position,
  count,
  onPrevious,
  onNext,
  focusKey,
}: {
  position: number
  count: number
  onPrevious: () => void
  onNext: () => void
  /** Takes focus on mount when a switch asked for it. */
  focusKey: string
}) {
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (pendingFocus !== focusKey) return
    pendingFocus = null
    root.current?.querySelector<HTMLElement>('button')?.focus()
  }, [focusKey])
  const first = position <= 1
  const last = position >= count
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'ArrowLeft' && !first) {
      event.preventDefault()
      onPrevious()
    } else if (event.key === 'ArrowRight' && !last) {
      event.preventDefault()
      onNext()
    }
  }
  return (
    <div
      ref={root}
      className="chat-version-control"
      role="group"
      aria-label="Message versions"
      data-testid="version-control"
      onKeyDown={onKeyDown}
    >
      <button
        type="button"
        className="chat-version-step"
        aria-label="Previous version"
        aria-disabled={first}
        onClick={() => !first && onPrevious()}
      >
        ‹
      </button>
      <span className="chat-version-position" aria-live="polite">
        <span aria-hidden="true">
          {position} / {count}
        </span>
        <span className="chat-sr-only">
          Version {position} of {count}
        </span>
      </span>
      <button
        type="button"
        className="chat-version-step"
        aria-label="Next version"
        aria-disabled={last}
        onClick={() => !last && onNext()}
      >
        ›
      </button>
    </div>
  )
}

/** What a message's control needs from whoever shows it: the older version being viewed switches through this. */
export type VersionView = { messageId: string; version: RoomVersion } | null

/** The control on a message that has older versions (null when it has none). `onSelect(null)` is the latest. */
export function MessageVersionControl({
  messageId,
  versions,
  onSelect,
}: {
  messageId: string
  versions: RoomVersion[]
  onSelect: (version: RoomVersion) => void
}) {
  const chain = versionChain(messageId, versions)
  if (chain.length === 0) return null
  const count = chain.length + 1
  return (
    <VersionControl
      position={count}
      count={count}
      focusKey={`live:${messageId}`}
      onPrevious={() => {
        pendingFocus = `bar:${messageId}`
        onSelect(chain[chain.length - 1]!)
      }}
      onNext={() => undefined}
    />
  )
}

function useVersionDetail(version: RoomVersion) {
  return useQuery({
    queryKey: ['chat', 'version', version.roomId, version.anchorId],
    queryFn: async () =>
      RoomVersionDetailSchema.parse(
        await apiFetch(
          `rooms/${encodeURIComponent(version.roomId)}/versions/${encodeURIComponent(version.anchorId)}`,
        ),
      ),
    staleTime: Infinity,
  })
}

const NOT_REWOUND = 'Agents weren’t rewound, so they may still remember it.'

/** The hidden messages of a version, read-only. A message that is itself a correction keeps its own control. */
function VersionItems({
  version,
  versions,
  agents,
}: {
  version: RoomVersion
  versions: RoomVersion[]
  agents: AgentSummary[]
}) {
  const detail = useVersionDetail(version)
  return (
    <>
      {detail.isPending && <p role="status">Loading…</p>}
      {detail.isError && <p role="alert">Couldn’t load that version.</p>}
      {detail.data && (
        <ReadOnlyMessages
          items={detail.data.items}
          anchorId={version.anchorId}
          versions={versions}
          agents={agents}
        />
      )}
    </>
  )
}

/**
 * Read-only messages. An edit whose correction is among them keeps its own `‹ n / count ›` (nested case), and viewing
 * one of its older versions replaces that message and the rest of this list, as in the live thread.
 */
function ReadOnlyMessages({
  items,
  anchorId,
  versions,
  agents,
}: {
  items: Message[]
  anchorId: string
  versions: RoomVersion[]
  agents: AgentSummary[]
}) {
  const [view, setView] = useState<VersionView>(null)
  const nodes: ReactNode[] = []
  for (const message of items) {
    if (view?.messageId === message.id) {
      nodes.push(
        <BranchView
          key={`branch:${message.id}`}
          messageId={message.id}
          version={view.version}
          versions={versions}
          agents={agents}
          onSelect={(next) => setView(next ? { messageId: message.id, version: next } : null)}
        />,
      )
      break
    }
    nodes.push(
      <MessageItem
        key={message.id}
        message={message}
        agents={agents}
        readOnly
        versionControl={
          message.id === anchorId ? undefined : (
            <MessageVersionControl
              messageId={message.id}
              versions={versions}
              onSelect={(version) => setView({ messageId: message.id, version })}
            />
          )
        }
      />,
    )
  }
  return <>{nodes}</>
}

/**
 * An older version of `messageId` on screen in place of that message and what followed it: the slim bar says so and
 * steps through the chain; "Back to latest" returns.
 */
export function BranchView({
  messageId,
  version,
  versions,
  agents,
  onSelect,
}: {
  messageId: string
  version: RoomVersion
  versions: RoomVersion[]
  agents: AgentSummary[]
  /** null = back to the latest. */
  onSelect: (version: RoomVersion | null) => void
}) {
  const chain = versionChain(messageId, versions)
  const count = chain.length + 1
  const at = Math.max(
    chain.findIndex((item) => item.id === version.id),
    0,
  )
  const back = () => {
    pendingFocus = `live:${messageId}`
    onSelect(null)
  }
  return (
    <div className="chat-branch" role="region" aria-label={`Version ${at + 1} of ${count}`}>
      <div className="chat-version-bar">
        <span>
          Viewing version {at + 1} of {count} · read-only
        </span>
        <VersionControl
          position={at + 1}
          count={count}
          focusKey={`bar:${messageId}`}
          onPrevious={() => onSelect(chain[at - 1]!)}
          onNext={() => (at + 1 < chain.length ? onSelect(chain[at + 1]!) : back())}
        />
        <button type="button" className="chat-version-toggle" onClick={back}>
          Back to latest
        </button>
        {version.skipped.length > 0 && <span className="chat-version-note">{NOT_REWOUND}</span>}
      </div>
      <div className="chat-previous">
        <VersionItems version={version} versions={versions} agents={agents} />
      </div>
    </div>
  )
}

/** A deleted message and what followed it, dimmed and read-only, where "Show deleted messages" is on. */
export function DeletedBlock({
  version,
  versions,
  agents,
}: {
  version: RoomVersion
  versions: RoomVersion[]
  agents: AgentSummary[]
}) {
  return (
    <div
      className="chat-previous chat-deleted"
      role="region"
      aria-label="Deleted messages"
      data-testid="deleted-messages"
    >
      <p className="chat-previous-note">
        Deleted, read-only. {version.hiddenCount} hidden{' '}
        {version.hiddenCount === 1 ? 'message' : 'messages'}.
        {version.skipped.length > 0 && ` ${NOT_REWOUND}`}
      </p>
      <VersionItems version={version} versions={versions} agents={agents} />
    </div>
  )
}

/** An edit whose rewind is done but whose correction was never sent: the original is hidden with no replacement yet. */
export function OpenEditNotice({
  version,
  versions,
  agents,
}: {
  version: RoomVersion
  versions: RoomVersion[]
  agents: AgentSummary[]
}) {
  const [viewing, setViewing] = useState(false)
  const [continuing, setContinuing] = useState(false)
  async function continueEditing() {
    setContinuing(true)
    try {
      const detail = RoomVersionDetailSchema.parse(
        await apiFetch(
          `rooms/${encodeURIComponent(version.roomId)}/versions/${encodeURIComponent(version.anchorId)}`,
        ),
      )
      const anchor = detail.items.find((message) => message.id === version.anchorId)
      // The rewind already happened: sending posts the correction without asking for it again.
      if (anchor) startEdit(anchor, { rewound: true })
    } finally {
      setContinuing(false)
    }
  }
  return (
    <div className="chat-version" data-testid="open-edit">
      <div className="chat-version-bar">
        <span>Edit not sent yet: the original is hidden</span>
        <button
          type="button"
          className="chat-version-toggle"
          aria-expanded={viewing}
          onClick={() => setViewing((value) => !value)}
        >
          {viewing ? 'Hide' : 'View'}
        </button>
        <button
          type="button"
          className="chat-version-toggle"
          disabled={continuing}
          onClick={() => void continueEditing()}
        >
          Continue editing
        </button>
      </div>
      {viewing && (
        <div className="chat-previous" role="region" aria-label="Original message">
          <VersionItems version={version} versions={versions} agents={agents} />
        </div>
      )}
    </div>
  )
}
