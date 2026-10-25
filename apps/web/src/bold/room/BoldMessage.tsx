import type { AgentSummary, JobResults, Message, RoomVersion } from '@score/contract'
import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useRef, useState, type ReactNode } from 'react'
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
 * Retry is offered on an agent reply that answers the person: the turn before it is the person's own message. (The server
 * retries the run that answered the person's message, and refuses an agent-to-agent hand-off or a step of a recipe.)
 */
export function answersPerson(message: Message, previous: Message | undefined) {
  return message.author.kind === 'agent' && previous?.author.kind === 'you'
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
}: {
  items: Message[]
  versions: RoomVersion[]
  agents: AgentSummary[]
  showDeleted: boolean
  branch: BranchSelection | null
  onBranchSelect: (messageId: string, version: BranchSelection['version'] | null) => void
  onlyJobId?: string | undefined
  renderMessage: (message: Message, previous: Message | undefined) => ReactNode
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
  const flush = (until: string | null) => {
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
  for (const message of items) {
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
    nodes.push(renderMessage(message, items[items.indexOf(message) - 1]))
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
  /** Whether the message answers the person's own message (see `answersPerson`): only then is Retry offered. */
  canRetry?: boolean
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

  async function retryReply() {
    setRetry('busy')
    setRetryError(null)
    try {
      await apiFetch(
        `rooms/${encodeURIComponent(message.roomId)}/messages/${encodeURIComponent(message.id)}/retry`,
        { method: 'POST', headers: { 'Idempotency-Key': newId() }, body: '{}' },
      )
      setRetry('queued')
      clearTimeout(retryTimer.current)
      retryTimer.current = setTimeout(() => setRetry('idle'), 2000)
    } catch (failure) {
      setRetry('idle')
      setRetryError(
        failure instanceof ApiError && failure.status === 409
          ? 'This reply can’t be retried right now.'
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
              aria-label={`Retry reply from ${author}`}
              disabled={retry !== 'idle'}
              onClick={() => void retryReply()}
            >
              {retry === 'idle' ? 'Retry reply' : 'Retrying'}
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
