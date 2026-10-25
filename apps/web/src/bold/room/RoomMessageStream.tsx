import type { AgentSummary, Job, Message } from '@score/contract'
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Link } from 'react-router'
import { AgentGlyph } from '../../components/AgentGlyph.tsx'
import { useStreamQuery } from '../../data/query-client.ts'
import { approvalsQuery, type MessagePageData } from '../../routes/chat/queries.ts'
import { usePendingDeletes } from '../../routes/chat/message-deletion.ts'
import { type VersionView } from '../../routes/chat/versions.tsx'
import { boldJobLink, boldMessageLink } from '../bold-links.ts'
import { agentDisplayName } from '../bold-agents.ts'
import {
  authorName,
  BoldMessage,
  buildMessageNodes,
  retryableIds,
  messageText,
} from './BoldMessage.tsx'
import { foldedJobIds, isFinishedJob, readExpandedJobs, writeExpandedJobs } from './job-fold.ts'
import { approvalPointerSet, jobMatchesFilter, type JobFilter } from './room-model.ts'
import { roomMessagesQuery, roomSeekQuery } from './room-queries.ts'
import { useMessageTools } from './use-message-tools.ts'

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

/** One finished job as a compact row: who worked on it, how it ended and how much was said. */
function FoldedJob({
  job,
  agents,
  messages,
  onShow,
}: {
  job: Job
  agents: AgentSummary[]
  messages: Message[]
  onShow: () => void
}) {
  const names = [
    ...new Set(
      messages.flatMap((message) =>
        message.author.kind === 'agent' ? [authorName(message, agents)] : [],
      ),
    ),
  ]
  const last = messages
    .filter(
      (message) => message.author.kind === 'agent' && !message.streaming && messageText(message),
    )
    .at(-1)
  const outcome = (last ? messageText(last) : (job.summary ?? '')).replace(/\s+/g, ' ').trim()
  const count = Math.max(job.messageCount, messages.length)
  return (
    <div className="bold-job-fold" data-job-id={job.id}>
      <span className="bold-job-fold-copy">
        <b>{job.title}</b>
        <span>
          {job.state === 'closed' ? 'Closed' : 'Done'}
          {names.length > 0 && ` · ${names.join(', ')}`} · {count}{' '}
          {count === 1 ? 'message' : 'messages'}
        </span>
        {outcome && <span className="bold-job-fold-last">{outcome}</span>}
      </span>
      <button type="button" aria-label={`Show ${job.title}`} onClick={onShow}>
        Show
      </button>
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
  const [messageNotice, setMessageNotice] = useState('')
  // The newest message time seen so far: only agent messages after it are news. Ids alone would call a tab switch, an
  // earlier page or an undone delete "new" (those messages merely became visible).
  const newestSeen = useRef<string | null>(null)
  const noticeTimer = useRef<ReturnType<typeof setTimeout> | null>(null)
  const lastNoticeAt = useRef(0)

  useEffect(
    () => () => {
      if (noticeTimer.current) clearTimeout(noticeTimer.current)
    },
    [],
  )

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

  const retryable = useMemo(() => retryableIds(allItems), [allItems])
  const { versions, isPinned, pinBusy, pinError, togglePin } = useMessageTools(roomId)
  const approvalsData = useStreamQuery(approvalsQuery).data
  const approvalPointerIds = useMemo(
    () => approvalPointerSet(approvalsData ?? [], roomId),
    [approvalsData, roomId],
  )
  const hidden = usePendingDeletes().hidden
  const [view, setView] = useState<
    (NonNullable<VersionView> & { filter: JobFilter; selectedJob: string }) | null
  >(null)

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

  useEffect(() => {
    if (status !== 'success') return
    const latest = items.reduce<string>(
      (newest, message) => (message.createdAt > newest ? message.createdAt : newest),
      '',
    )
    if (newestSeen.current === null) {
      // The first page is history, not news: remember how far it goes without speaking.
      newestSeen.current = latest
      return
    }
    const since = newestSeen.current
    const fresh = items.filter(
      (message) => message.createdAt > since && message.author.kind === 'agent',
    )
    if (latest > since) newestSeen.current = latest
    if (fresh.length === 0) return
    const newest = fresh.at(-1)!
    if (newest.author.kind !== 'agent') return
    const delay = Math.max(0, 2_000 - (Date.now() - lastNoticeAt.current))
    if (noticeTimer.current) return
    const announce = () => {
      noticeTimer.current = null
      lastNoticeAt.current = Date.now()
      setMessageNotice(`New message from ${authorName(newest, agents)}`)
    }
    noticeTimer.current = setTimeout(announce, delay)
  }, [agents, items, status])

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

  const [expandedJobs, setExpandedJobs] = useState<Set<string>>(readExpandedJobs)
  function setJobOpen(jobId: string, open: boolean) {
    setExpandedJobs((current) => {
      const next = new Set(current)
      if (open) next.add(jobId)
      else next.delete(jobId)
      writeExpandedJobs(next)
      return next
    })
  }
  const branch = view?.filter === filter && view.selectedJob === selectedJob ? view : null
  let nodes: ReactNode[] = []
  if (status === 'success') {
    // Finished jobs fold into one row in All; a branch view or the deleted-message markers need the whole stream.
    const folded =
      selectedJob === 'all' && !branch && !showDeleted
        ? foldedJobIds({
            jobs,
            messages: items,
            expanded: expandedJobs,
            isPinned,
            approvalPointerIds,
            seek,
          })
        : new Set<string>()
    const build = (list: Message[]) =>
      buildMessageNodes({
        items: list,
        versions,
        agents,
        showDeleted,
        branch,
        onlyJobId: selectedJob === 'all' ? undefined : selectedJob,
        onBranchSelect: (messageId, version) =>
          setView(version ? { messageId, version, filter, selectedJob } : null),
        renderMessage: (message) => (
          <BoldMessage
            key={message.id}
            message={message}
            agents={agents}
            versions={versions}
            approvalPointerIds={approvalPointerIds}
            canRetry={retryable.has(message.id)}
            onView={(version) => setView({ messageId: message.id, version, filter, selectedJob })}
            pinned={isPinned(message.id)}
            pinBusy={pinBusy === message.id}
            onTogglePin={() => void togglePin(message.id)}
          />
        ),
      })
    let built: { nodes: ReactNode[]; branched: boolean }
    const hideable = new Set(
      selectedJob === 'all' && !branch && !showDeleted
        ? jobs
            .filter((item) => isFinishedJob(item) && expandedJobs.has(item.id))
            .map((item) => item.id)
        : [],
    )
    if (folded.size === 0 && hideable.size === 0) built = build(items)
    else {
      built = { nodes: [], branched: false }
      let run: Message[] = []
      const shown = new Set<string>()
      for (const message of items) {
        const own = message.jobId && (folded.has(message.jobId) || hideable.has(message.jobId))
        if (!own) {
          run.push(message)
          continue
        }
        const job = jobs.find((item) => item.id === message.jobId)!
        if (!folded.has(job.id)) {
          if (!shown.has(job.id)) {
            shown.add(job.id)
            built.nodes.push(...build(run).nodes)
            run = []
            built.nodes.push(
              <p key={`hide-${job.id}`} className="bold-job-hide">
                {job.title}
                <button type="button" onClick={() => setJobOpen(job.id, false)}>
                  Hide
                </button>
              </p>,
            )
          }
          run.push(message)
          continue
        }
        if (shown.has(job.id)) continue
        shown.add(job.id)
        built.nodes.push(...build(run).nodes)
        run = []
        built.nodes.push(
          <FoldedJob
            key={`fold-${job.id}`}
            job={job}
            agents={agents}
            messages={allItems.filter((item) => item.jobId === job.id)}
            onShow={() => setJobOpen(job.id, true)}
          />,
        )
      }
      built.nodes.push(...build(run).nodes)
    }
    nodes = built.nodes
    const effectiveView = built.branched
    if (!effectiveView)
      for (const job of jobs.filter(
        (item) =>
          item.state === 'done' &&
          !folded.has(item.id) &&
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
              <span>{holder ? `Done · ${agentDisplayName(holder)}` : 'Done'}</span>
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
      <span className="bold-sr-only" role="status" aria-live="polite">
        {messageNotice}
      </span>
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
            <b>{agentDisplayName(agent)}</b> {text}
          </p>
        )
      })}
    </div>
  )
}
