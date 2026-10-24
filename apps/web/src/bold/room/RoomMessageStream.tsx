import type { AgentSummary, Job, Message, RoomVersion } from '@score/contract'
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link, useSearchParams } from 'react-router'
import { AgentGlyph } from '../../components/AgentGlyph.tsx'
import { copyText } from '../../data/clipboard.ts'
import { useStreamQuery } from '../../data/query-client.ts'
import { MessageItem } from '../../routes/chat/MessageItem.tsx'
import { messagesQuery, versionsQuery } from '../../routes/chat/queries.ts'
import { requestDelete, usePendingDeletes } from '../../routes/chat/message-deletion.ts'
import { startEdit } from '../../routes/chat/message-edit.ts'
import { RewindDialog } from '../../routes/chat/RewindDialog.tsx'
import {
  BranchView,
  DeletedBlock,
  MessageVersionControl,
  type VersionView,
} from '../../routes/chat/versions.tsx'
import { saveCandidates, SaveToKnowledge } from '../../routes/knowledge/SaveToKnowledge.tsx'
import { jobMatchesFilter, type JobFilter } from './room-model.ts'

function messageText(message: Message) {
  return message.parts
    .flatMap((part) => (part.kind === 'text' ? [part.text] : []))
    .join('\n\n')
}

function authorName(message: Message, agents: AgentSummary[]) {
  if (message.author.kind === 'you') return 'You'
  const id = message.author.agentId
  return agents.find((agent) => agent.id === id)?.name ?? id
}

function atOrAfter(message: Message, anchor: Message) {
  return (
    message.createdAt > anchor.createdAt ||
    (message.createdAt === anchor.createdAt && message.id >= anchor.id)
  )
}

function MessageWithActions({
  message,
  agents,
  versions,
  onView,
}: {
  message: Message
  agents: AgentSummary[]
  versions: RoomVersion[]
  onView: (version: RoomVersion) => void
}) {
  const [copied, setCopied] = useState(false)
  const [saving, setSaving] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])
  const imported = message.id.startsWith('import:')
  const mine = message.author.kind === 'you'
  const author = authorName(message, agents)
  const text = messageText(message)
  const finished = !message.streaming && !message.id.startsWith('pending-')
  const canSave = saveCandidates(message, author).length > 0

  async function copy() {
    if (!(await copyText(text))) return
    setCopied(true)
    clearTimeout(timer.current)
    timer.current = setTimeout(() => setCopied(false), 2000)
  }

  return (
    <div className="bold-message" data-message-id={message.id}>
      <MessageItem
        message={message}
        agents={agents}
        versionControl={
          <MessageVersionControl messageId={message.id} versions={versions} onSelect={onView} />
        }
      />
      {finished && (
        <div
          className="bold-acts"
          role="group"
          aria-label={`Actions for message from ${author}`}
        >
          {mine && !imported && !message.editedBy && (
            <button
              type="button"
              className="bold-act"
              aria-label={`Edit message from ${author}`}
              onClick={() => startEdit(message)}
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
      {saving && (
        <SaveToKnowledge message={message} authorName={author} onClose={() => setSaving(false)} />
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
    </div>
  )
}

/** The live stream for All or one job, with the classic message cards and the prototype's hover row. */
export function RoomMessageStream({
  roomId,
  jobs,
  agents,
  selectedJob,
  filter,
  showDeleted,
  seek,
}: {
  roomId: string
  jobs: Job[]
  agents: AgentSummary[]
  selectedJob: string
  filter: JobFilter
  showDeleted: boolean
  seek: string | null
}) {
  const defaultJob = jobs.find((job) => job.isDefault)?.id ?? null
  const definition = useMemo(() => messagesQuery(roomId), [roomId])
  const { data, status } = useStreamQuery(definition)
  const versions = useStreamQuery(useMemo(() => versionsQuery(roomId), [roomId])).data ?? []
  const hidden = usePendingDeletes().hidden
  const [view, setView] = useState<VersionView>(null)
  const seeked = useRef<string | null>(null)
  const [params] = useSearchParams()

  const items = useMemo(() => {
    const shownJobs = new Set(
      jobs.filter((job) => jobMatchesFilter(job, filter)).map((job) => job.id),
    )
    return (data?.items ?? [])
      .filter((message) => {
        if (hidden.has(message.id)) return false
        if (selectedJob === 'all') {
          if (!message.jobId) return true
          return shownJobs.has(message.jobId)
        }
        return message.jobId === selectedJob || (message.jobId == null && selectedJob === defaultJob)
      })
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id))
  }, [data, defaultJob, filter, hidden, jobs, selectedJob])

  useEffect(() => setView(null), [filter, roomId, selectedJob])

  useEffect(() => {
    if (!seek || status !== 'success' || seeked.current === seek) return
    if (!data?.items.some((message) => message.id === seek)) return
    const found = document.getElementById(`message-${seek}`)
    if (!found) return
    seeked.current = seek
    requestAnimationFrame(() => {
      found.scrollIntoView?.({ block: 'center' })
      found.classList.add('bold-message-hit')
      found.focus({ preventScroll: true })
    })
  }, [data, seek, status])

  const anchor = view ? items.find((message) => message.id === view.messageId) : undefined
  const effectiveView = anchor ? view : null
  const nodes: ReactNode[] = []
  if (status === 'success') {
    const markers =
      showDeleted && selectedJob === 'all'
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
          />,
        )
      }
    }
    for (const message of items) {
      if (effectiveView && anchor && atOrAfter(message, anchor)) {
        if (message.id === anchor.id)
          nodes.push(
            <BranchView
              key={`branch-${anchor.id}`}
              messageId={anchor.id}
              version={effectiveView.version}
              versions={versions}
              agents={agents}
              onSelect={(version) =>
                setView(version ? { messageId: anchor.id, version } : null)
              }
            />,
          )
        break
      }
      flush(message.createdAt)
      nodes.push(
        <MessageWithActions
          key={message.id}
          message={message}
          agents={agents}
          versions={versions}
          onView={(version) => setView({ messageId: message.id, version })}
        />,
      )
    }
    flush(null)
    if (!effectiveView)
      for (const job of jobs.filter(
        (item) =>
          item.state === 'done' &&
          jobMatchesFilter(item, filter) &&
          (selectedJob === 'all' || selectedJob === item.id),
      )) {
        const latest = (data?.items ?? [])
          .filter(
            (message) =>
              message.jobId === job.id &&
              message.author.kind === 'agent' &&
              !message.streaming &&
              messageText(message),
          )
          .sort(
            (a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id),
          )[0]
        const holder = agents.find((agent) => agent.id === job.holderAgentId)
        const search = new URLSearchParams(params)
        search.set('job', job.id)
        if (latest) search.set('message', latest.id)
        nodes.push(
          <Link
            key={`result-${job.id}`}
            className="bold-result"
            to={`/b?${search.toString()}`}
            aria-label={`Open result: ${job.title}`}
          >
            <span
              className="bold-result-icon"
              aria-hidden="true"
              style={holder ? { background: holder.style.color } : undefined}
            >
              {holder && <AgentGlyph agent={holder} size="xs" decorative />}
            </span>
            <span className="bold-result-copy">
              <b>{job.title}</b>
              <span>{holder ? `Done · ${holder.name}` : 'Done'}</span>
            </span>
          </Link>,
        )
      }
  }

  return (
    <div className="bold-stream" aria-label="Team room messages">
      {status === 'pending' && (
        <p className="bold-stream-note" role="status">
          Loading messages…
        </p>
      )}
      {status === 'error' && (
        <p className="bold-stream-note" role="alert">
          Couldn’t load messages. Try again.
        </p>
      )}
      {status === 'success' && items.length === 0 && !showDeleted && (
        <p className="bold-stream-empty">Nothing here yet. Write below to start.</p>
      )}
      {nodes}
      {Object.entries(data?.typing ?? {}).map(([agentId, text]) => {
        const agent = agents.find((item) => item.id === agentId)
        if (!agent) return null
        return (
          <p className="bold-typing" key={agentId} role="status">
            <b>{agent.name}</b> {text}
          </p>
        )
      })}
    </div>
  )
}
