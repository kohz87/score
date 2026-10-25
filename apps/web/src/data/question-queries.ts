import {
  AgentQuestionListSchema,
  AgentQuestionSchema,
  type AgentQuestion,
  type AgentQuestionAnswer,
} from '@score/contract'
import { useQueryClient } from '@tanstack/react-query'
import { useState } from 'react'
import { pairingProblem } from '../bold/bold-errors.ts'
import { ApiError, apiFetch } from './api.ts'
import { newId } from './ids.ts'
import { defineStreamQuery, type StreamSnapshot } from './resync.ts'

// 2.3.0 (decision 128): an agent's question is its own needs-you entity (contract §6a), never an approval. One list of
// every question (newest first, at most 200) serves the strips, the dock, the one-to-one view and the muted lines in
// the stream; the stream events keep it live, the same way `approvalsQuery` does for approvals.
export const questionsQuery = defineStreamQuery<AgentQuestion[]>({
  key: ['questions', 'all'],
  async fetch(signal) {
    const { asOfSeq, items } = AgentQuestionListSchema.parse(
      await apiFetch('questions?status=all', { signal }),
    )
    return { asOfSeq, data: items }
  },
  types: ['question.requested', 'question.updated'],
  reduce(data, event) {
    if (event.type !== 'question.requested' && event.type !== 'question.updated') return data
    return withQuestion(data, event.data)
  },
})

/** The question in place, or where it belongs when it is new (newest first, at most 200 like the server's list). */
export function withQuestion(list: AgentQuestion[], question: AgentQuestion): AgentQuestion[] {
  if (list.some((item) => item.id === question.id))
    return list.map((item) => (item.id === question.id ? question : item))
  return [...list, question]
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id.localeCompare(a.id))
    .slice(0, 200)
}

/** The one rule for a question that waits on the person; the dock, the strip, the badge and the card share it. */
export function questionNeedsYou(question: AgentQuestion): boolean {
  // The answer is on its way (`delivering`): the card stays, saying so, until Hermes took it or it failed.
  return question.status === 'pending' || question.delivery === 'delivering'
}

/** A question belongs to a room's strip when it names that room; one that names none shows in the team room. */
export function questionInRoom(
  question: Pick<AgentQuestion, 'roomId'>,
  roomId: string,
  teamRoom: boolean,
): boolean {
  return question.roomId === roomId || (question.roomId === null && teamRoom)
}

/** The pending questions one room's strip shows: its own, and a job filter keeps that job's and the job-less ones. */
export function roomQuestions(
  questions: AgentQuestion[],
  roomId: string | null,
  teamRoom: boolean,
  selectedJob: string,
): AgentQuestion[] {
  if (roomId === null) return []
  return questions.filter(
    (question) =>
      questionNeedsYou(question) &&
      questionInRoom(question, roomId, teamRoom) &&
      (selectedJob === 'all' || question.jobId === null || question.jobId === selectedJob),
  )
}

/** "waits until 3:42 PM" in the person's local time. */
export function questionDeadline(question: Pick<AgentQuestion, 'expiresAt'>): string | null {
  if (!question.expiresAt) return null
  const at = new Date(question.expiresAt)
  if (Number.isNaN(at.getTime())) return null
  return `waits until ${at.toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`
}

/** What the muted line in the stream says about an ended question. */
export function questionOutcome(question: AgentQuestion): string {
  if (question.status === 'answered') {
    const answer = Array.isArray(question.answer) ? question.answer.join(', ') : question.answer
    if (question.answeredBy === 'elsewhere') return 'answered elsewhere'
    if (question.answeredBy === 'timeout') return 'no answer (timed out)'
    return answer ? `you answered: ${answer}` : 'you answered'
  }
  if (question.status === 'expired') return 'no answer (timed out)'
  return 'no longer needed'
}

/**
 * Writes a question the server sent back (a POST response or the `details` of a 409) into the list at once; the
 * stream replaces it with the same or a newer version.
 */
export function useCacheQuestion() {
  const queryClient = useQueryClient()
  return {
    /** The cached version now (an event may replace it while a request is in flight). */
    current: (id: string) =>
      queryClient
        .getQueryData<StreamSnapshot<AgentQuestion[]>>(questionsQuery.key)
        ?.data.find((item) => item.id === id),
    /**
     * Writes `question` unless the stream already changed the cached version since `expected` was read: a late POST
     * response must never undo the newer `question.updated` (the card would stick on "Delivering…").
     */
    write: (question: AgentQuestion, expected: AgentQuestion | undefined) =>
      queryClient.setQueryData<StreamSnapshot<AgentQuestion[]>>(questionsQuery.key, (snapshot) => {
        if (!snapshot) return snapshot
        const now = snapshot.data.find((item) => item.id === question.id)
        if (now !== expected) return snapshot
        return { ...snapshot, data: withQuestion(snapshot.data, question) }
      }),
  }
}

/** The answer mutation of one question. The outcome (applied or failed) arrives as `question.updated`. */
export function useAnswerQuestion(questionId: string) {
  const cache = useCacheQuestion()
  const [posted, setPosted] = useState<AgentQuestion | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)

  async function answer(value: AgentQuestionAnswer): Promise<AgentQuestion | null> {
    setBusy(true)
    setError(null)
    const before = cache.current(questionId)
    try {
      const result = AgentQuestionSchema.parse(
        await apiFetch(`questions/${encodeURIComponent(questionId)}/answer`, {
          method: 'POST',
          headers: { 'Idempotency-Key': newId() },
          body: JSON.stringify({ answer: value }),
        }),
      )
      setPosted(result)
      cache.write(result, before)
      return result
    } catch (caught) {
      if (caught instanceof ApiError && caught.status === 409) {
        // No longer pending (answered elsewhere, timed out): take the current item so the card goes.
        const current = AgentQuestionSchema.safeParse(caught.details)
        if (current.success) {
          setPosted(current.data)
          cache.write(current.data, before)
        }
        setError('This question was already settled.')
      } else {
        setError(pairingProblem(caught) ?? 'Couldn’t send your answer. Try again.')
      }
      return null
    } finally {
      setBusy(false)
    }
  }

  return { posted, busy, error, answer }
}
