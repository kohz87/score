import type { AgentSummary, JobResults, Message, RoomVersion } from '@score/contract'
import { useQueryClient } from '@tanstack/react-query'
import { Fragment, useEffect, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { apiFetch, ApiError } from '../../data/api.ts'
import { copyText } from '../../data/clipboard.ts'
import { newId } from '../../data/ids.ts'
import { MessageItem } from '../../routes/chat/MessageItem.tsx'
import { requestDelete } from '../../routes/chat/message-deletion.ts'
import { startEdit } from '../../routes/chat/message-edit.ts'
import type { WorkspaceTarget } from '../../routes/chat/workspace-link.ts'
import { RewindDialog } from '../../routes/chat/RewindDialog.tsx'
import {
  BranchView,
  DeletedBlock,
  MessageVersionControl,
  type VersionView,
} from '../../routes/chat/versions.tsx'
import { saveCandidates, SaveToKnowledge } from '../../routes/knowledge/SaveToKnowledge.tsx'
import { boldWorkspaceLink } from '../bold-links.ts'
import { fetchJobResults, jobResultsKey } from '../bold-results-queries.ts'
import { agentDisplayName } from '../bold-agents.ts'
import { ReplyGroup, type ReplyGroupParts } from './ReplyGroup.tsx'
import { clearPickedVersion, groupKey, groupReplies, isFailedReply } from './reply-versions.ts'

// One message with the prototype's action row (Edit, Copy, Save, Retry, Pin, Delete) and its versions. The team room,
// the one-to-one chat and the job thread all draw their messages with it, so a message does the same everywhere.
export function messageText(message: Message) {
  return message.parts.flatMap((part) => (part.kind === 'text' ? [part.text] : [])).join('\n\n')
}

export function authorName(message: Message, agents: AgentSummary[]) {
  if (message.author.kind === 'you') return 'You'
  const id = message.author.agentId
  const agent = agents.find((item) => item.id === id)
  return agent ? agentDisplayName(agent) : id
}

export function atOrAfter(message: Message, anchor: Message) {
  return (
    message.createdAt > anchor.createdAt ||
    (message.createdAt === anchor.createdAt && message.id >= anchor.id)
  )
}

/**
 * Retry is offered on an agent reply that answers the person: the server's `retryable` when it sends one (3.5.0), else
 * walking back over the job's agent-authored messages, the first other message is the person's own. (The server refuses an agent-to-agent hand-off or a step of a recipe.) Pass
 * the job's whole, oldest-first list, not a filtered one, so a filter or a pending delete never changes the answer.
 */
export function retryableIds(messages: Message[]): Set<string> {
  const ids = new Set<string>()
  const lastOther = new Map<string, Message['author']['kind']>()
  for (const message of messages) {
    const job = message.jobId ?? ''
    if (message.author.kind === 'agent') {
      // The server says (3.5.0); older messages fall back to the walk.
      if (message.retryable ?? lastOther.get(job) === 'you') ids.add(message.id)
    } else lastOther.set(job, message.author.kind)
  }
  return ids
}

export type BranchSelection = NonNullable<VersionView>

/**
 * Lays messages out oldest to newest with the deleted-message markers (when shown) between them. A viewed branch
 * replaces its anchor and everything after it.
 */
export function buildMessageNodes({
  items,
  versions,
  agents,
  showDeleted,
  branch,
  onBranchSelect,
  onlyJobId,
  renderMessage,
  notes,
}: {
  items: Message[]
  versions: RoomVersion[]
  agents: AgentSummary[]
  showDeleted: boolean
  branch: BranchSelection | null
  onBranchSelect: (messageId: string, version: BranchSelection['version'] | null) => void
  onlyJobId?: string | undefined
  /** `group` is set when the message is the shown version of a group of replies (Try another / Retry). */
  renderMessage: (message: Message, group?: ReplyGroupParts) => ReactNode
  /**
   * Muted lines placed where they happened (an ended agent question). `used` is shared by the runs of one stream so a
   * line shows once; `tail` says whether the lines after the last message go here (the stream's final run).
   */
  notes?: { items: { id: string; at: string; node: ReactNode }[]; used: Set<string>; tail: boolean }
}): { nodes: ReactNode[]; branched: boolean } {
  const anchor = branch ? items.find((message) => message.id === branch.messageId) : undefined
  const effective = anchor ? branch : null
  const nodes: ReactNode[] = []
  const markers = showDeleted
    ? versions
        .filter((version) => version.mode === 'delete')
        .sort((a, b) => a.anchorCreatedAt.localeCompare(b.anchorCreatedAt))
    : []
  let marker = 0
  const flushNotes = (until: string | null) => {
    if (!notes) return
    for (const note of notes.items) {
      if (notes.used.has(note.id)) continue
      if (until === null ? !notes.tail : note.at > until) continue
      notes.used.add(note.id)
      nodes.push(<Fragment key={`note-${note.id}`}>{note.node}</Fragment>)
    }
  }
  const flush = (until: string | null) => {
    flushNotes(until)
    while (markers[marker] && (until === null || markers[marker]!.anchorCreatedAt <= until)) {
      const version = markers[marker++]!
      nodes.push(
        <DeletedBlock
          key={`deleted-${version.id}`}
          version={version}
          versions={versions}
          agents={agents}
          onlyJobId={onlyJobId}
        />,
      )
    }
  }
  const groups = groupReplies(items)
  for (const message of items) {
    if (groups.folded.has(message.id)) continue
    if (effective && anchor && atOrAfter(message, anchor)) {
      if (message.id === anchor.id)
        nodes.push(
          <BranchView
            key={`branch-${anchor.id}`}
            messageId={anchor.id}
            version={effective.version}
            versions={versions}
            agents={agents}
            onSelect={(version) => onBranchSelect(anchor.id, version)}
          />,
        )
      break
    }
    flush(message.createdAt)
    const group = groups.byHead.get(message.id)
    nodes.push(
      group ? (
        <ReplyGroup
          key={`group-${message.id}`}
          group={group}
          agentName={authorName(message, agents)}
          render={renderMessage}
        />
      ) : (
        renderMessage(message)
      ),
    )
  }
  flush(null)
  return { nodes, branched: effective !== null }
}

export function BoldMessage({
  message,
  agents,
  versions,
  onView,
  pinned,
  pinBusy,
  onTogglePin,
  approvalPointerIds,
  className,
  bold = true,
  canRetry = false,
  replyGroup,
  onEdit,
  children,
}: {
  message: Message
  agents: AgentSummary[]
  versions: RoomVersion[]
  onView: (version: RoomVersion) => void
  pinned: boolean
  pinBusy: boolean
  onTogglePin: () => void
  approvalPointerIds?: ReadonlySet<string>
  /** The place's own wrapper class (`bold-dm-message`, `bold-thread-message`) beside `bold-message`. */
  className?: string
  /** False where the classic card styling is kept (the job thread). */
  bold?: boolean
  /** Whether the message answers the person's own message (see `retryableIds`): only then is Retry offered. */
  canRetry?: boolean
  /** Set when this is the shown version of a group of replies: its pager and memory note go under the bubble. */
  replyGroup?: ReplyGroupParts | undefined
  /** Runs after Edit hands the message to the composer (the phone sheet closes so the composer can be used). */
  onEdit?: () => void
  /** Extra rows that belong to the message (the one-to-one's share row). */
  children?: ReactNode
}) {
  const [copied, setCopied] = useState(false)
  const [saving, setSaving] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [retry, setRetry] = useState<'idle' | 'busy' | 'queued'>('idle')
  const [retryError, setRetryError] = useState<string | null>(null)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const retryTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  // One BoldMessage shows every version of a reply group (2.4.0, so the pager keeps focus): a switch to another
  // version starts its actions fresh, so no confirm, label or error carries over to the other message.
  const [shownId, setShownId] = useState(message.id)
  if (shownId !== message.id) {
    setShownId(message.id)
    setCopied(false)
    setSaving(false)
    setConfirmDelete(false)
    setRetry('idle')
    setRetryError(null)
  }
  useEffect(
    () => () => {
      clearTimeout(timer.current)
      clearTimeout(retryTimer.current)
    },
    [],
  )
  const imported = message.id.startsWith('import:')
  const mine = message.author.kind === 'you'
  const author = authorName(message, agents)
  const text = messageText(message)
  const finished = !message.streaming && !message.id.startsWith('pending-')
  const canSave = saveCandidates(message, author).length > 0
  // `workspace://` links (11.6b): a file this message's job changed opens in its Workbench, any other file in the agent's
  // workspace. The job's changed files come from the Results data the side panel already holds (no extra request).
  const queryClient = useQueryClient()
  const workspaceLinkFor = (target: WorkspaceTarget) => {
    const jobId = message.jobId ?? null
    const results = jobId ? queryClient.getQueryData<JobResults>(jobResultsKey(jobId)) : undefined
    const files =
      results?.items.flatMap((item) =>
        item.kind === 'change' ? item.files.map((file) => file.path) : [],
      ) ?? []
    return boldWorkspaceLink(target.agentId, target.path, jobId ? { id: jobId, files } : undefined)
  }

  async function prepareWorkspaceLink() {
    const jobId = message.jobId ?? null
    if (!jobId) return
    const key = jobResultsKey(jobId)
    const query = queryClient.getQueryCache().find({ queryKey: key, exact: true })
    if (!query || (!query.isStale() && query.state.fetchStatus !== 'fetching')) return
    await queryClient.fetchQuery({
      queryKey: key,
      queryFn: ({ signal }) => fetchJobResults(jobId, signal),
      staleTime: 0,
      retry: false,
    })
  }

  async function copy() {
    if (!(await copyText(text))) return
    setCopied(true)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setCopied(false), 2000)
  }

  const failed = isFailedReply(message)

  async function retryReply(another: boolean) {
    setRetry('busy')
    setRetryError(null)
    try {
      await apiFetch(
        `rooms/${encodeURIComponent(message.roomId)}/messages/${encodeURIComponent(message.id)}/retry`,
        {
          method: 'POST',
          headers: { 'Idempotency-Key': newId() },
          body: JSON.stringify(another ? { another: true } : {}),
        },
      )
      // The new version should be what the person sees next, not an older pick.
      clearPickedVersion(groupKey(message))
      setRetry('queued')
      clearTimeout(retryTimer.current)
      retryTimer.current = setTimeout(() => setRetry('idle'), 2000)
    } catch (failure) {
      setRetry('idle')
      setRetryError(
        failure instanceof ApiError && failure.status === 409
          ? another
            ? 'This reply can’t be tried again right now.'
            : 'This reply can’t be retried right now.'
          : another
            ? 'Couldn’t ask for another reply. Try again.'
            : 'Couldn’t retry. Try again.',
      )
    }
  }

  return (
    <div
      className={`bold-message${className ? ` ${className}` : ''}`}
      data-message-id={message.id}
      tabIndex={0}
    >
      <MessageItem
        message={message}
        agents={agents}
        bold={bold}
        workspaceLinkFor={workspaceLinkFor}
        workspacePrepare={prepareWorkspaceLink}
        approvalPointerIds={approvalPointerIds}
        versionControl={
          <MessageVersionControl messageId={message.id} versions={versions} onSelect={onView} />
        }
      />
      {replyGroup && (
        <div className="bold-reply-versions">
          {replyGroup.pager}
          {replyGroup.note}
        </div>
      )}
      {finished && (
        <div className="bold-acts" role="group" aria-label={`Actions for message from ${author}`}>
          {mine && !imported && !message.editedBy && (
            <button
              type="button"
              className="bold-act"
              aria-label={`Edit message from ${author}`}
              onClick={() => {
                startEdit(message)
                onEdit?.()
              }}
            >
              Edit
            </button>
          )}
          {text && (
            <button
              type="button"
              className="bold-act"
              aria-label={`Copy message from ${author}`}
              onClick={() => void copy()}
            >
              {copied ? 'Copied' : 'Copy'}
            </button>
          )}
          {canSave && (
            <button
              type="button"
              className="bold-act"
              aria-label={`Save message from ${author} to Library`}
              onClick={() => setSaving(true)}
            >
              Save to Library
            </button>
          )}
          {!mine && !imported && canRetry && (
            <button
              type="button"
              className="bold-act"
              aria-label={`${failed ? 'Retry reply' : 'Try another reply'} from ${author}`}
              disabled={retry !== 'idle' || (!failed && replyGroup?.writing === true)}
              onClick={() => void retryReply(!failed)}
            >
              {retry === 'idle' ? (failed ? 'Retry reply' : 'Try another') : 'Asking'}
            </button>
          )}
          {!imported && (
            <button
              type="button"
              className="bold-act"
              aria-label={`${pinned ? 'Unpin' : 'Pin'} message from ${author}`}
              aria-pressed={pinned}
              disabled={pinBusy}
              onClick={onTogglePin}
            >
              {pinned ? 'Unpin' : 'Pin'}
            </button>
          )}
          {!imported && (
            <button
              type="button"
              className="bold-act"
              aria-label={`Delete message from ${author}`}
              onClick={() => {
                if (mine) setConfirmDelete(true)
                else requestDelete(message.roomId, message.id)
              }}
            >
              Delete
            </button>
          )}
        </div>
      )}
      {saving &&
        // The stream is masked (its top fade), which would clip a fixed dialog inside it: render it at the shell.
        createPortal(
          <SaveToKnowledge
            message={message}
            authorName={author}
            onClose={() => setSaving(false)}
          />,
          document.querySelector('[data-ui="bold"]') ?? document.body,
        )}
      {confirmDelete && (
        <RewindDialog
          roomId={message.roomId}
          messageId={message.id}
          mode="delete"
          agents={agents}
          onDone={() => setConfirmDelete(false)}
          onClose={() => setConfirmDelete(false)}
        />
      )}
      {copied && (
        <span className="small muted" role="status">
          Copied
        </span>
      )}
      {retryError && (
        <span className="bold-act-error" role="alert">
          {retryError}
        </span>
      )}
      {children}
    </div>
  )
}
