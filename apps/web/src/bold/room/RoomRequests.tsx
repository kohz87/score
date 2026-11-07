import type { AgentSummary, Job, Message } from '@score/contract'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useStreamQuery } from '../../data/query-client.ts'
import { questionsQuery, roomQuestions } from '../../data/question-queries.ts'
import { approvalsQuery } from '../../routes/chat/queries.ts'
import { NeedsSlot, NeedsSlotsProvider, slotIds, useNeedsSlotsOuter } from './needs-slots.tsx'
import { PinsProvider, usePinRegistry } from './PinCards.tsx'
import { useQuestionAnnouncement } from './QuestionCard.tsx'
import { approvalNeedsYou } from './room-model.ts'
import { RoomApprovals } from './ApprovalRequests.tsx'
import { RoomExchanges } from './ExchangeRequests.tsx'
import { NeedsFocusTracker } from './NeedsFocusTracker.tsx'
import { NeedsJumpChip } from './NeedsJumpChip.tsx'
import { RoomFence } from './RoomFenceCard.tsx'
import { RoomQuestions } from './RoomQuestionRequests.tsx'
import { RoomReportBacks } from './ReportBackRequests.tsx'
import { RoomTaskRequests } from './RoomTasks.tsx'
import { RunSafetyRequests } from './RunSafetyRequests.tsx'
import { useRoomNeedsYouState } from './use-needs-you.ts'

export { decisionError } from './room-request-decisions.ts'

/**
 * 3.24.0: the needs-you cards are drawn inside the conversation (see needs-slots.tsx), after the message that asked.
 * This component owns the reads, the announcements and the focus hand-off, and renders the cards into their slots.
 */
export function RoomRequests(props: Parameters<typeof RoomRequestsInner>[0]) {
  // Alone (no stream around it) the cards fall back to a plain list in place.
  const outer = useNeedsSlotsOuter()
  return outer ? (
    <RoomRequestsInner {...props} />
  ) : (
    <NeedsSlotsProvider>
      <RoomRequestsInner {...props} />
    </NeedsSlotsProvider>
  )
}

function RoomRequestsInner({
  roomId,
  jobs,
  agents,
  messages,
  selectedJob,
  teamRoom = false,
}: {
  roomId: string
  jobs: Job[]
  agents: AgentSummary[]
  messages?: Message[]
  selectedJob: string
  teamRoom?: boolean
}) {
  const approvals = useStreamQuery(approvalsQuery).data ?? []
  const pins = usePinRegistry()
  const focusedKey = useRef<string | null>(null)
  const lastCards = useRef<typeof pins.cards>([])
  const lastVisible = useRef<string[]>([])
  const trackFocus = useCallback((key: string) => {
    focusedKey.current = key
  }, [])
  const selectedJobs = jobs.filter(
    (job) => job.state !== 'closed' && (selectedJob === 'all' || job.id === selectedJob),
  )
  const cooking = selectedJobs.filter(
    (job) => job.state === 'waiting_on_you' || job.state === 'working',
  )
  const recipeJobs = selectedJobs.filter((job) => job.recipe !== null)
  const needsApproval = approvals.filter(approvalNeedsYou)
  const needs = useRoomNeedsYouState({ roomId, jobs, messages, selectedJob, teamRoom })
  const questionsRead = useStreamQuery(questionsQuery)
  const questions = roomQuestions(questionsRead.data ?? [], roomId, teamRoom, selectedJob)
  const total = needs.total
  // Questions announce in their own sentence; the count sentence covers the rest.
  const countedTotal = total - needs.questionCount
  const questionAnnouncement = useQuestionAnnouncement(
    questions,
    questionsRead.status === 'success',
    agents,
  )
  const lastTotal = useRef<number | null>(null)
  const settled = useRef(false)
  const [announcement, setAnnouncement] = useState('')

  useEffect(() => {
    if (!needs.ready) return
    if (!settled.current) {
      settled.current = true
      lastTotal.current = countedTotal
      return
    }
    // A status region only announces text that changes. Clear it when the count falls, so the same text can announce
    // again on the next rise (2 → 1 → 2).
    if (countedTotal < (lastTotal.current ?? 0)) setAnnouncement('')
    else if (countedTotal > (lastTotal.current ?? 0)) setAnnouncement(`${total} need you`)
    lastTotal.current = countedTotal
  }, [needs.ready, countedTotal, total])

  // A card that goes takes the focus with it: the next card (or the composer) gets it instead.
  useEffect(() => {
    const visible = pins.cards.map((card) => card.key)
    const lost = lastVisible.current.find((key) => !visible.includes(key))
    if (lost && focusedKey.current === lost) {
      const active = document.activeElement
      const activeKey =
        active instanceof Element
          ? active.closest('[data-pin-key]')?.getAttribute('data-pin-key')
          : null
      if (!activeKey || activeKey === lost) {
        const lostIndex = lastCards.current.findIndex((card) => card.key === lost)
        const ordered = pins.cards.filter((card) => visible.includes(card.key))
        const next = ordered[Math.min(Math.max(lostIndex, 0), ordered.length - 1)]
        const target = next
          ? document.querySelector<HTMLElement>(`[data-pin-key=${JSON.stringify(next.key)}]`)
          : document.querySelector<HTMLElement>('.bold-room-composer textarea')
        target?.focus()
        focusedKey.current = null
      }
    }
    lastCards.current = pins.cards
    lastVisible.current = visible
  }, [pins.cards])

  return (
    <PinsProvider value={pins.value}>
      {/* The status node stays mounted at zero so its first 0 → 1 change is announced. */}
      <span className="bold-sr-only" role="status">
        {announcement}
      </span>
      {/* Its own region, so a question never hides the "N need you" (or the other way round). */}
      <span className="bold-sr-only" role="status">
        {questionAnnouncement}
      </span>
      {/* Where no conversation is drawn (an empty room, still loading) the cards sit here, in plain view. */}
      <NeedsSlot id={slotIds.fallback} className="bold-needs-fallback" />
      <NeedsFocusTracker onFocusKey={trackFocus} />
      {total > 0 && (
        <>
          <RoomFence />
          <RoomApprovals
            roomId={roomId}
            approvals={needsApproval}
            messages={messages ?? []}
            jobs={jobs}
            selectedJob={selectedJob}
            agents={agents}
          />
          <RoomQuestions questions={questions} jobs={jobs} agents={agents} />
          <RoomExchanges jobs={cooking} agents={agents} />
          <RoomReportBacks roomId={roomId} jobs={jobs} />
          <RunSafetyRequests jobs={recipeJobs} agents={agents} />
          <RoomTaskRequests roomId={roomId} agents={agents} teamRoom={teamRoom} />
          <NeedsJumpChip cardKeys={pins.cards.map((card) => card.key)} />
        </>
      )}
    </PinsProvider>
  )
}
