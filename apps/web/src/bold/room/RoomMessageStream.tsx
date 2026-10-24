import type { AgentSummary, Job, Message, RoomVersion } from '@score/contract'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { Link } from 'react-router'
import { AgentGlyph } from '../../components/AgentGlyph.tsx'
import { apiFetch, ApiError } from '../../data/api.ts'
import { copyText } from '../../data/clipboard.ts'
import { newId } from '../../data/ids.ts'
import { useStreamQuery, useStreamQueryRefetch } from '../../data/query-client.ts'
import { MessageItem } from '../../routes/chat/MessageItem.tsx'
import { versionsQuery, type MessagePageData } from '../../routes/chat/queries.ts'
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
import { boldJobLink, boldMessageLink } from '../bold-links.ts'
import { jobMatchesFilter, type JobFilter } from './room-model.ts'
import { roomMessagesQuery, roomPinsQuery, roomSeekQuery, setRoomPin } from './room-queries.ts'

function messageText(message: Message) {
  return message.parts.flatMap((part) => (part.kind === 'text' ? [part.text] : [])).join('\n\n')
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

type PageState = {
  data?: MessagePageData & { found?: boolean }
  status: 'pending' | 'success' | 'error'
  error?: unknown
}

function pageKey(jobId: string | null, before: string | null) {
  return `${jobId ?? 'default'}::${before ?? 'latest'}`
}

function seekMarker(seek: string) {
  return `seek:${seek}`
}

function jobKey(jobId: string | null) {
  return jobId ?? 'default'
}

/** Registers one page with the stream and hands its latest state to the stream that draws them all in order. */
function MessagePageCollector({
  roomId,
  jobId,
  before,
  defaultJobId,
  onPage,
}: {
  roomId: string
  jobId: string | null
  before: string | null
  defaultJobId: string | null
  onPage: (key: string, state: PageState) => void
}) {
  const definition = useMemo(
    () => roomMessagesQuery(roomId, jobId, before, defaultJobId),
    [before, defaultJobId, jobId, roomId],
  )
  const { data, status, error } = useStreamQuery(definition)
  useEffect(() => {
    onPage(pageKey(jobId, before), { data, status, error })
  }, [before, data, error, jobId, onPage, status])
  return null
}

/** Reads back through the job's history to a `?message=` target without paging state. */
function MessageSeekCollector({
  roomId,
  jobId,
  seek,
  onPage,
}: {
  roomId: string
  jobId: string | null
  seek: string
  onPage: (key: string, state: PageState) => void
}) {
  const definition = useMemo(() => roomSeekQuery(roomId, jobId, seek), [jobId, roomId, seek])
  const { data, status, error } = useStreamQuery(definition)
  useEffect(() => {
    onPage(pageKey(jobId, seekMarker(seek)), { data, status, error })
  }, [data, error, jobId, onPage, seek, status])
  return null
}

function MessageWithActions({
  message,
  agents,
  versions,
  onView,
  pinned,
  pinBusy,
  onTogglePin,
}: {
  message: Message
  agents: AgentSummary[]
  versions: RoomVersion[]
  onView: (version: RoomVersion) => void
  pinned: boolean
  pinBusy: boolean
  onTogglePin: () => void
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
          ? 'Can’t retry right now: it is already being answered, or work is paused.'
          : 'Couldn’t retry. Try again.',
      )
    }
  }

  return (
    <div className="bold-message" data-message-id={message.id} tabIndex={0}>
      <MessageItem
        message={message}
        agents={agents}
        bold
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
          {!mine && !imported && (
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
  openedJobs,
  onRevealSeek,
  onSeeked,
}: {
  roomId: string
  jobs: Job[]
  agents: AgentSummary[]
  selectedJob: string
  filter: JobFilter
  showDeleted: boolean
  seek: string | null
  /** Jobs whose tab has been opened; All draws their pages too without reading any other job. */
  openedJobs: string[]
  onRevealSeek: (jobId: string | null) => void
  onSeeked: () => void
}) {
  const defaultJob = jobs.find((job) => job.isDefault)?.id ?? null
  const [older, setOlder] = useState<Record<string, string[]>>({})
  const [pageStates, setPageStates] = useState<Record<string, PageState>>({})
  const seeked = useRef<string | null>(null)

  const reportPage = useCallback((key: string, state: PageState) => {
    setPageStates((current) => {
      const previous = current[key]
      if (
        previous &&
        previous.data === state.data &&
        previous.status === state.status &&
        previous.error === state.error
      )
        return current
      return { ...current, [key]: state }
    })
  }, [])

  // All shows the room thread plus the jobs that are read or have been opened. An unread job's page is not read
  // until its tab is selected, so its badge means "not opened yet".
  const visibleJobIds = useMemo(() => {
    if (selectedJob !== 'all') return [selectedJob]
    const ids = jobs
      .filter((job) => job.isDefault || job.unread === 0 || openedJobs.includes(job.id))
      .map((job) => job.id)
    const unique = [...new Set(ids)]
    return unique.length ? unique : [null]
  }, [jobs, openedJobs, selectedJob])

  const pageRefs = useMemo(
    () =>
      visibleJobIds.flatMap((jobId) =>
        [null, ...(older[jobKey(jobId)] ?? [])].map((before) => ({ jobId, before })),
      ),
    [older, visibleJobIds],
  )

  const seekJobId = selectedJob === 'all' ? defaultJob : selectedJob
  const allRefs = useMemo(
    () => (seek ? [...pageRefs, { jobId: seekJobId, before: seekMarker(seek) }] : pageRefs),
    [pageRefs, seek, seekJobId],
  )

  const states = allRefs.map((ref) => pageStates[pageKey(ref.jobId, ref.before)])
  const status = states.some((state) => state?.status === 'success')
    ? 'success'
    : states.some((state) => state?.status === 'error')
      ? 'error'
      : 'pending'

  const allItems = useMemo(() => {
    const byId = new Map<string, Message>()
    for (const ref of allRefs) {
      const page = pageStates[pageKey(ref.jobId, ref.before)]?.data
      for (const message of page?.items ?? []) byId.set(message.id, message)
    }
    return [...byId.values()].sort(
      (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
    )
  }, [allRefs, pageStates])

  const pinsDefinition = useMemo(() => roomPinsQuery(roomId), [roomId])
  const pins = useStreamQuery(pinsDefinition)
  const refetchPins = useStreamQueryRefetch(pinsDefinition)
  const [pinOverrides, setPinOverrides] = useState<Record<string, boolean>>({})
  const [pinBusy, setPinBusy] = useState<string | null>(null)
  const [pinError, setPinError] = useState<string | null>(null)
  const versionsDefinition = useMemo(() => versionsQuery(roomId), [roomId])
  const versions = useStreamQuery(versionsDefinition).data ?? []
  const hidden = usePendingDeletes().hidden
  const [view, setView] = useState<
    (NonNullable<VersionView> & { filter: JobFilter; selectedJob: string }) | null
  >(null)
  const pinnedIds = useMemo(
    () => new Set((pins.data?.items ?? []).map((pin) => pin.messageId)),
    [pins.data],
  )
  const pinsRevision = pins.data?.revision ?? 0

  useEffect(() => {
    if (pinsRevision > 0) void refetchPins()
  }, [pinsRevision, refetchPins])

  function isPinned(messageId: string) {
    return pinOverrides[messageId] ?? pinnedIds.has(messageId)
  }

  async function togglePin(messageId: string) {
    const next = !isPinned(messageId)
    setPinBusy(messageId)
    setPinError(null)
    try {
      await setRoomPin(roomId, messageId, next)
      setPinOverrides((current) => ({ ...current, [messageId]: next }))
      void refetchPins()
    } catch (failure) {
      setPinError(
        failure instanceof ApiError ? failure.message : 'Couldn’t change the pin. Try again.',
      )
    } finally {
      setPinBusy(null)
    }
  }

  const items = useMemo(() => {
    const shownJobs = new Set(
      jobs.filter((job) => jobMatchesFilter(job, filter)).map((job) => job.id),
    )
    return allItems.filter((message) => {
      if (hidden.has(message.id)) return false
      if (selectedJob === 'all') {
        if (!message.jobId) return true
        return shownJobs.has(message.jobId)
      }
      return message.jobId === selectedJob || (message.jobId == null && selectedJob === defaultJob)
    })
  }, [allItems, defaultJob, filter, hidden, jobs, selectedJob])

  const addOlder = useCallback((jobId: string | null, cursor: string) => {
    setOlder((current) => {
      const key = jobKey(jobId)
      const list = current[key] ?? []
      return list.includes(cursor) ? current : { ...current, [key]: [...list, cursor] }
    })
  }, [])

  // "Load earlier" walks backwards through the job on show (the room thread when All is selected).
  const historyJob = selectedJob === 'all' ? defaultJob : selectedJob
  const historyCursors = [null, ...(older[jobKey(historyJob)] ?? [])]
  const historyLast = pageStates[pageKey(historyJob, historyCursors.at(-1) ?? null)]
  const historyCursor =
    historyLast?.status === 'success' ? (historyLast.data?.nextCursor ?? null) : null

  useEffect(() => {
    if (seek) return
    seeked.current = null
  }, [seek])

  const seekPage = seek ? pageStates[pageKey(seekJobId, seekMarker(seek))] : undefined
  const seekFound = seek ? allItems.some((message) => message.id === seek) : false
  // The seek query walks the history itself; these outcomes are derived from its one result rather than set by an
  // effect that pages backwards.
  const seekError =
    !seek || seekFound
      ? null
      : seekPage?.status === 'error'
        ? 'Couldn’t load the history to find that message.'
        : seekPage?.status === 'success' && seekPage.data?.found === false
          ? 'Couldn’t find that message. It may have been deleted or moved.'
          : null

  // Once loaded, a target hidden by the D10 filter reveals itself in All; either way the URL keeps the link clean.
  useEffect(() => {
    if (!seek || seeked.current === seek) return
    const target = allItems.find((message) => message.id === seek)
    if (!target) return
    if (!items.some((message) => message.id === seek)) {
      onRevealSeek(target.jobId ?? defaultJob)
      return
    }
    const found = document.getElementById(`message-${seek}`)
    if (!found) return
    seeked.current = seek
    requestAnimationFrame(() => {
      found.scrollIntoView?.({ block: 'center' })
      found.classList.add('bold-message-hit')
      found.focus({ preventScroll: true })
      onSeeked()
    })
  }, [allItems, defaultJob, items, onRevealSeek, onSeeked, seek])

  const branch = view?.filter === filter && view.selectedJob === selectedJob ? view : null
  const anchor = branch ? items.find((message) => message.id === branch.messageId) : undefined
  const effectiveView = anchor ? branch : null
  const nodes: ReactNode[] = []
  if (status === 'success') {
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
            onlyJobId={selectedJob === 'all' ? undefined : selectedJob}
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
                setView(version ? { messageId: anchor.id, version, filter, selectedJob } : null)
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
          onView={(version) => setView({ messageId: message.id, version, filter, selectedJob })}
          pinned={isPinned(message.id)}
          pinBusy={pinBusy === message.id}
          onTogglePin={() => void togglePin(message.id)}
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
        const latest = allItems
          .filter(
            (message) =>
              message.jobId === job.id &&
              message.author.kind === 'agent' &&
              !message.streaming &&
              messageText(message),
          )
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))[0]
        const holder = agents.find((agent) => agent.id === job.holderAgentId)
        nodes.push(
          <Link
            key={`result-${job.id}`}
            className="bold-result"
            to={latest ? boldMessageLink(job.id, latest.id) : boldJobLink(job.id)}
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

  const typing: Record<string, string> = Object.assign(
    {},
    ...states.map((state): Record<string, string> => state?.data?.typing ?? {}),
  )

  return (
    <div className="bold-stream" aria-label="Team room messages">
      {pageRefs.map((ref) => (
        <MessagePageCollector
          key={pageKey(ref.jobId, ref.before)}
          roomId={roomId}
          jobId={ref.jobId}
          before={ref.before}
          defaultJobId={defaultJob}
          onPage={reportPage}
        />
      ))}
      {seek && (
        <MessageSeekCollector roomId={roomId} jobId={seekJobId} seek={seek} onPage={reportPage} />
      )}
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
      {pinError && (
        <p className="bold-stream-note" role="alert">
          {pinError}
        </p>
      )}
      {seekError && (
        <p className="bold-stream-note" role="status">
          {seekError}
        </p>
      )}
      {status === 'success' && historyCursor && (
        <button
          type="button"
          className="bold-history"
          onClick={() => addOlder(historyJob, historyCursor)}
        >
          Load earlier
        </button>
      )}
      {status === 'success' && items.length === 0 && !showDeleted && (
        <p className="bold-stream-empty">
          {selectedJob === 'all' && jobs.some((job) => job.messageCount > 0)
            ? 'Choose a job to read its messages.'
            : 'Nothing here yet. Write below to start.'}
        </p>
      )}
      {nodes}
      {Object.entries(typing).map(([agentId, text]) => {
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
