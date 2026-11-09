import type { AgentSummary, Job, Message } from '@score/contract'
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useStreamQuery } from '../../data/query-client.ts'
import './bold-thread.css'
import { approvalsQuery } from '../../routes/chat/queries.ts'
import { usePendingDeletes } from '../../routes/chat/message-deletion.ts'
import { type VersionView } from '../../routes/chat/versions.tsx'
import { authorName, BoldMessage, buildMessageNodes, retryableIds } from './BoldMessage.tsx'
import { approvalPointerSet, holdsSeveralJobs } from './room-model.ts'
import {
  emptyTopics,
  SystemLineRow,
  TopicAnchor,
  TopicDivider,
  topicDividers,
  type SystemLine,
} from './topic-divider.tsx'
import { groupKey, groupReplies, pickReplyVersion } from './reply-versions.ts'
import { RunCard } from './RunCard.tsx'
import { QuestionNote } from './QuestionCard.tsx'
import { questionNeedsYou, questionsQuery } from '../../data/question-queries.ts'
import { useMessageTools } from './use-message-tools.ts'
import { NeedsSlot, slotIds } from './needs-slots.tsx'
import {
  MessagePageCollector,
  MessageSeekCollector,
  pageKey,
  seekMarker,
  type PageState,
} from './room-message-pages.tsx'
import { RoomTyping } from './RoomTyping.tsx'
import { useRoomLiveCards } from './use-room-live-cards.ts'
import { useRoomSubagentRows } from '../subagents/subagent-queries.ts'
import { attachSubagentRows } from '../subagents/subagent-model.ts'
import { SubagentStatusCard } from '../subagents/SubagentStatusCard.tsx'

/** The chat as one conversation: every topic's messages in time order, a divider where each topic starts. */
export function RoomMessageStream({
  roomId,
  jobs,
  agents,
  showDeleted,
  seek,
  onSeeked,
  focusTopic = null,
  oneJobPerChat = false,
  topicMenu,
  systemLines = [],
  messageExtras,
  onShowGraph,
}: {
  roomId: string
  jobs: Job[]
  agents: AgentSummary[]
  showDeleted: boolean
  seek: string | null
  onSeeked: () => void
  /** The topic the person picked (Info, a divider or a link): the stream scrolls to its divider when it changes. */
  focusTopic?: string | null
  /** 3.28.0: a group chat holds one job at a time, so its dividers go (a one-to-one keeps them for its earlier chats). */
  oneJobPerChat?: boolean
  /** The per-topic menu drawn in each divider. */
  topicMenu?: (job: Job) => ReactNode
  /** Small local lines for what a command changed ("You made builder the owner"). */
  systemLines?: SystemLine[]
  /** 3.23.0: a topic that holds a run shows its card after the divider; Show graph opens the side panel's Graph tab. */
  onShowGraph?: (jobId: string) => void
  /**
   * Extra buttons and rows on a message (a one-to-one adds Share to the team room). `lastReply` marks the newest
   * finished reply of an agent in the conversation.
   */
  messageExtras?: (
    message: Message,
    info: { lastReply: boolean },
  ) => { actions?: ReactNode; below?: ReactNode } | undefined
}) {
  const defaultJob = jobs.find((job) => job.isDefault)?.id ?? null
  const liveCards = useRoomLiveCards(jobs)
  const runCard = (job: Job) =>
    job.recipe && onShowGraph ? (
      <RunCard
        job={job}
        recipe={job.recipe}
        agents={agents}
        live={liveCards.has(job.id)}
        onShowGraph={onShowGraph}
      />
    ) : null
  const [older, setOlder] = useState<string[]>([])
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

  const pageRefs = useMemo(() => [null, ...older], [older])

  const allRefs = useMemo(
    () => (seek ? [...pageRefs, seekMarker(seek)] : pageRefs),
    [pageRefs, seek],
  )

  const states = allRefs.map((ref) => pageStates[pageKey(ref)])
  const status = states.some((state) => state?.status === 'success')
    ? 'success'
    : states.some((state) => state?.status === 'error')
      ? 'error'
      : 'pending'

  const allItems = useMemo(() => {
    const byId = new Map<string, Message>()
    for (const ref of allRefs) {
      const page = pageStates[pageKey(ref)]?.data
      for (const message of page?.items ?? []) byId.set(message.id, message)
    }
    return [...byId.values()].sort(
      (a, b) => a.createdAt.localeCompare(b.createdAt) || a.id.localeCompare(b.id),
    )
  }, [allRefs, pageStates])

  const retryable = useMemo(() => retryableIds(allItems), [allItems])
  const lastReplyId = useMemo(
    () =>
      [...allItems]
        .reverse()
        .find(
          (message) =>
            message.author.kind === 'agent' &&
            !message.streaming &&
            !message.id.startsWith('pending-'),
        )?.id ?? null,
    [allItems],
  )
  const { versions, isPinned, pinBusy, pinError, togglePin } = useMessageTools(roomId)
  const approvalsData = useStreamQuery(approvalsQuery).data
  const questionsData = useStreamQuery(questionsQuery).data
  const approvalPointerIds = useMemo(
    () => approvalPointerSet(approvalsData ?? [], roomId),
    [approvalsData, roomId],
  )
  const hidden = usePendingDeletes().hidden
  const [branch, setView] = useState<VersionView>(null)

  const subagentJobIds = useMemo(
    () => jobs.filter((job) => job.subagents).map((job) => job.id),
    [jobs],
  )
  const subagentRows = useRoomSubagentRows(subagentJobIds)

  // The merged conversation shows every topic, closed ones too: their divider says how they ended.
  const items = useMemo(
    () => allItems.filter((message) => !hidden.has(message.id)),
    [allItems, hidden],
  )
  const subagentCards = useMemo(
    () => attachSubagentRows(subagentRows, allItems),
    [allItems, subagentRows],
  )

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

  const addOlder = useCallback((cursor: string) => {
    setOlder((current) => (current.includes(cursor) ? current : [...current, cursor]))
  }, [])

  // "Load earlier" walks backwards through the chat's one chain.
  const historyLast = pageStates[pageKey(older.at(-1) ?? null)]
  const historyCursor =
    historyLast?.status === 'success' ? (historyLast.data?.nextCursor ?? null) : null

  useEffect(() => {
    if (seek) return
    seeked.current = null
  }, [seek])

  const seekPage = seek ? pageStates[pageKey(seekMarker(seek))] : undefined
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

  useEffect(() => {
    if (!seek || seeked.current === seek) return
    if (!items.some((message) => message.id === seek)) return
    const reveal = (found: HTMLElement) => {
      found.scrollIntoView?.({ block: 'center' })
      found.classList.add('bold-message-hit')
      found.focus({ preventScroll: true })
      onSeeked()
    }
    const found = document.getElementById(`message-${seek}`)
    if (!found) {
      // A version hidden inside its reply group: select it there first, then the usual scroll and highlight.
      const group = [...groupReplies(items).byHead.values()].find((list) =>
        list.some((message) => message.id === seek),
      )
      if (!group) return
      seeked.current = seek
      pickReplyVersion(groupKey(group[0]!), seek)
      requestAnimationFrame(() =>
        requestAnimationFrame(() => {
          const shown = document.getElementById(`message-${seek}`)
          if (shown) reveal(shown)
          else onSeeked()
        }),
      )
      return
    }
    seeked.current = seek
    requestAnimationFrame(() => reveal(found))
  }, [items, onSeeked, seek])

  // The newest message of each topic: a card with no message of its own sits after it, at the topic's end.
  const lastOfTopic = new Map<string, string>()
  for (const message of items) if (message.jobId) lastOfTopic.set(message.jobId, message.id)
  let nodes: ReactNode[] = []
  if (status === 'success') {
    // Ended agent questions stay in the stream as muted lines where they were asked; each shows once per render.
    const noteItems = (questionsData ?? [])
      .filter((question) => !questionNeedsYou(question) && question.roomId === roomId)
      .sort((a, b) => a.createdAt.localeCompare(b.createdAt))
      .map((question) => ({
        id: question.id,
        at: question.createdAt,
        node: <QuestionNote question={question} agents={agents} />,
      }))
    const usedNotes = new Set<string>()
    const usedMarkers = new Set<string>()
    const build = (list: Message[], tail = true) =>
      buildMessageNodes({
        notes: { items: noteItems, used: usedNotes, tail },
        usedMarkers,
        items: list,
        versions,
        agents,
        showDeleted,
        branch,
        onBranchSelect: (messageId, version) => setView(version ? { messageId, version } : null),
        renderMessage: (message, replyGroup) => {
          const extras = messageExtras?.(message, { lastReply: message.id === lastReplyId })
          return (
            <BoldMessage
              key={message.id}
              message={message}
              agents={agents}
              versions={versions}
              approvalPointerIds={approvalPointerIds}
              canRetry={retryable.has(message.id)}
              replyGroup={replyGroup}
              onView={(version) => setView({ messageId: message.id, version })}
              pinned={isPinned(message.id)}
              pinBusy={pinBusy === message.id}
              onTogglePin={() => void togglePin(message.id)}
              extraActions={extras?.actions}
            >
              {extras?.below}
              {/* 3.24.0: a needs-you card for this message (or the end of its topic) is drawn right after it. */}
              <NeedsSlot id={slotIds.message(message.id)} />
              {subagentCards.get(message.id)?.map((rows) => {
                const agentId = rows[0]!.agentId
                return (
                  <SubagentStatusCard
                    key={`subagents-${agentId}-${message.id}`}
                    rows={rows}
                    agent={agents.find((agent) => agent.id === agentId)}
                  />
                )
              })}
              {message.jobId && lastOfTopic.get(message.jobId) === message.id && (
                <NeedsSlot id={slotIds.topic(message.jobId)} />
              )}
            </BoldMessage>
          )
        },
      })
    let built: { nodes: ReactNode[]; branched: boolean }
    if (!branch) {
      // One conversation: runs of one topic's messages, each opened by its divider, plus small system lines.
      built = { nodes: [], branched: false }
      const dividers = topicDividers(jobs, items)
      const quiet = emptyTopics(jobs, items)
      // 3.28.0: one job per chat, so the dividers have nothing to tell apart; an older chat that still holds several
      // active jobs keeps them. The run card stays either way, and the job's anchor keeps "scroll to it" working.
      const dividerAt = (job: Job | null, again: boolean) =>
        !oneJobPerChat || holdsSeveralJobs(jobs) ? (
          <TopicDivider job={job} again={again} menu={job ? topicMenu?.(job) : undefined} />
        ) : job && !again ? (
          <TopicAnchor job={job} />
        ) : null
      const marks: { at: string; node: ReactNode }[] = [
        ...quiet.map((job) => ({
          at: job.createdAt,
          node: (
            <Fragment key={`topic-${job.id}`}>
              {dividerAt(job, false)}
              {runCard(job)}
              <NeedsSlot id={slotIds.topic(job.id)} />
            </Fragment>
          ),
        })),
        ...systemLines.map((line) => ({
          at: line.at,
          node: <SystemLineRow key={`system-${line.id}`} line={line} />,
        })),
      ].sort((a, b) => a.at.localeCompare(b.at))
      let run: Message[] = []
      let next = 0
      const flush = (tail: boolean) => {
        // The final run is always built: it also places the ended-question notes that came after the last message.
        if (run.length || tail) built.nodes.push(...build(run, tail).nodes)
        run = []
      }
      for (const message of items) {
        while (next < marks.length && marks[next]!.at <= message.createdAt) {
          flush(false)
          built.nodes.push(marks[next++]!.node)
        }
        const divider = dividers.get(message.id)
        if (divider) {
          flush(false)
          built.nodes.push(
            <Fragment key={`divider-${message.id}`}>
              {dividerAt(divider.job, divider.again)}
              {divider.job && !divider.again && runCard(divider.job)}
            </Fragment>,
          )
        }
        run.push(message)
      }
      flush(true)
      for (; next < marks.length; next += 1) built.nodes.push(marks[next]!.node)
    } else built = build(items)
    nodes = built.nodes
  }

  // A topic picked in Info, on a divider or through a link: bring its divider into view once it is drawn.
  const focused = useRef<string | null>(null)
  useEffect(() => {
    if (!focusTopic || status !== 'success' || seek) return
    if (focused.current === focusTopic) return
    const divider = document.getElementById(`topic-${focusTopic}`)
    if (!divider) return
    focused.current = focusTopic
    divider.scrollIntoView?.({ block: 'start' })
  }, [focusTopic, nodes.length, seek, status])
  useEffect(() => {
    if (!focusTopic) focused.current = null
  }, [focusTopic])

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
          key={pageKey(ref)}
          roomId={roomId}
          before={ref}
          defaultJobId={defaultJob}
          onPage={reportPage}
        />
      ))}
      {seek && <MessageSeekCollector roomId={roomId} seek={seek} onPage={reportPage} />}
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
        <button type="button" className="bold-history" onClick={() => addOlder(historyCursor)}>
          Load earlier
        </button>
      )}
      {status === 'success' &&
        items.length === 0 &&
        !showDeleted &&
        // A topic with a run card is not empty (3.23.0): its card shows even before its first message.
        !(onShowGraph && jobs.some((job) => job.recipe)) && (
          <p className="bold-stream-empty">Nothing here yet. Write below to start.</p>
        )}
      {nodes}
      <NeedsSlot id={slotIds.end} />
      <RoomTyping agents={agents} typing={typing} />
      {/* Sticks above the composer: "2 need you ↑" when a card is out of view. */}
      <NeedsSlot id={slotIds.chip} className="bold-needs-chip-slot" />
    </div>
  )
}
