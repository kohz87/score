import {
  ImportSessionResponseSchema,
  JobSchema,
  JobsResponseSchema,
  MessagePageSchema,
  type Job,
  type Message,
  type OutsideSession,
} from '@score/contract'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { ApiError, apiFetch } from './api.ts'
import { newId } from './ids.ts'

export interface OutsideSessionPreview {
  roomId: string
  messages: Message[]
}

export interface BringOutsideSessionIntoJobResult {
  job: Job
  importedRoomId: string
  attached: number
}

/**
 * One person's "bring it in" attempt. The job is reused and shared message ids are never sent twice. Each HTTP call
 * has its own idempotency key: the server stores every answer, including errors, for 24 hours, so only a call whose
 * response was never received keeps its key for the retry. A replayed 500 would otherwise make Try again useless.
 */
export interface BringOutsideSessionAttempt {
  importedRoomId: string | null
  job: Job | null
  sharedMessageIds: Set<string>
  /** Keys for calls that failed before an HTTP response; only those same calls may send them again. */
  pendingKeys: Map<string, string>
  /** How many times in a row a call was told its first request is still running on the server. */
  stillRunning: Map<string, number>
}

export function newBringOutsideSessionAttempt(
  importedRoomId: string | null = null,
): BringOutsideSessionAttempt {
  return {
    importedRoomId,
    job: null,
    sharedMessageIds: new Set(),
    pendingKeys: new Map(),
    stillRunning: new Map(),
  }
}

/** After this many "still running" answers in a row the server most likely restarted mid-request: give up the key. */
const STILL_RUNNING_LIMIT = 2

/**
 * Sends one keyed write. An HTTP answer (even an error) is final for its key and is discarded; a transport failure
 * (network error or abort) keeps it so the retry can recover the answer the server may already have stored.
 */
async function keyedWrite(
  attempt: BringOutsideSessionAttempt,
  call: string,
  path: string,
  body: unknown,
): Promise<unknown> {
  const key = attempt.pendingKeys.get(call) ?? newId()
  attempt.pendingKeys.set(call, key)
  try {
    const result = await apiFetch(path, {
      method: 'POST',
      headers: { 'Idempotency-Key': key },
      body: JSON.stringify(body),
    })
    attempt.pendingKeys.delete(call)
    attempt.stillRunning.delete(call)
    return result
  } catch (error) {
    // A pending receipt never expires on the server, so a request lost in a server crash answers this forever.
    if (error instanceof ApiError && error.code === 'idempotency_pending') {
      const times = (attempt.stillRunning.get(call) ?? 0) + 1
      attempt.stillRunning.set(call, times)
      if (times < STILL_RUNNING_LIMIT) throw error
      attempt.pendingKeys.delete(call)
      attempt.stillRunning.delete(call)
      throw new ApiError(
        409,
        'idempotency_pending',
        'Score may have stopped while copying this chat. Check the team room for a job with this title before trying again.',
      )
    }
    // A lost connection may have reached the server without its answer reaching us; so may a request still running
    // there (`idempotency_pending`) or a gateway's 5xx with no Score answer in it (`request_failed`). Those keep the key
    // so the retry gets the stored answer. Any answer from Score itself, error or not, is final for this key.
    const lost =
      (error instanceof ApiError &&
        (error.status === 0 ||
          error.code === 'idempotency_pending' ||
          (error.status >= 500 && error.code === 'request_failed'))) ||
      (error instanceof DOMException && error.name === 'AbortError') ||
      error instanceof TypeError
    if (!lost) attempt.pendingKeys.delete(call)
    throw error
  }
}

function textOf(message: Message): string {
  return message.parts
    .filter((part) => part.kind === 'text')
    .map((part) => (part.kind === 'text' ? part.text : ''))
    .join('\n')
    .trim()
}

async function importedMessages(roomId: string): Promise<Message[]> {
  const items = new Map<string, Message>()
  const cursors = new Set<string>()
  let before: string | null = null
  for (let page = 0; page < 25; page += 1) {
    const params = new URLSearchParams({ limit: '100' })
    if (before !== null) params.set('before', before)
    const snapshot = MessagePageSchema.parse(
      await apiFetch(`rooms/${encodeURIComponent(roomId)}/messages?${params}`),
    )
    for (const message of snapshot.items) items.set(message.id, message)
    const next = snapshot.nextCursor
    if (!next || cursors.has(next)) break
    cursors.add(next)
    before = next
  }
  return sortImportedMessages([...items.values()])
}

function importSequence(id: string): number | null {
  const match = /(\d+)$/.exec(id)
  return match ? Number(match[1]) : null
}

/** Copied messages keep their original times; the import index breaks a tie without sorting `10` before `2`. */
export function sortImportedMessages(messages: Message[]): Message[] {
  return [...messages].sort(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) ||
      (importSequence(left.id) ?? Number.POSITIVE_INFINITY) -
        (importSequence(right.id) ?? Number.POSITIVE_INFINITY) ||
      left.id.localeCompare(right.id),
  )
}

/**
 * The contract has no single "preview and attach this outside chat to a job" call. Its pieces do fit together: import
 * the session as a read-only room, read the copied messages, then create a team job and share each text message into
 * it as the frozen copy the share endpoint defines. This exists because `GET /api/outside-sessions` returns session
 * metadata only, not a transcript.
 */
export async function previewOutsideSession(
  session: OutsideSession,
): Promise<OutsideSessionPreview> {
  const imported = ImportSessionResponseSchema.parse(
    await apiFetch('outside-sessions/import', {
      method: 'POST',
      body: JSON.stringify({ agentId: session.agentId, sessionId: session.id }),
    }),
  )
  return {
    roomId: imported.roomId,
    messages: (await importedMessages(imported.roomId)).filter((message) => textOf(message)),
  }
}

/**
 * Attaching has no single contract call either: the import (idempotent on its own), a team job and the message share
 * endpoint are stitched together. The job is made once per attempt and retries share only messages not yet copied.
 */
export async function bringOutsideSessionIntoJob(
  session: OutsideSession,
  teamRoomId: string,
  attempt: BringOutsideSessionAttempt = newBringOutsideSessionAttempt(),
): Promise<BringOutsideSessionIntoJobResult> {
  return bringOnce(session, teamRoomId, attempt, true)
}

/** Forget what this attempt made so it starts over: the job or the imported chat it kept was deleted meanwhile. */
function startOver(attempt: BringOutsideSessionAttempt): void {
  attempt.job = null
  attempt.importedRoomId = null
  attempt.sharedMessageIds.clear()
  attempt.pendingKeys.clear()
  attempt.stillRunning.clear()
}

async function jobStillThere(teamRoomId: string, jobId: string): Promise<boolean> {
  const jobs = JobsResponseSchema.parse(
    await apiFetch(`rooms/${encodeURIComponent(teamRoomId)}/jobs`),
  )
  return jobs.items.some((item) => item.id === jobId)
}

const notFound = (error: unknown) => error instanceof ApiError && error.status === 404

async function bringOnce(
  session: OutsideSession,
  teamRoomId: string,
  attempt: BringOutsideSessionAttempt,
  mayStartOver: boolean,
): Promise<BringOutsideSessionIntoJobResult> {
  const again = () => {
    startOver(attempt)
    return bringOnce(session, teamRoomId, attempt, false)
  }
  const importedRoomId =
    attempt.importedRoomId ??
    ImportSessionResponseSchema.parse(
      await apiFetch('outside-sessions/import', {
        method: 'POST',
        body: JSON.stringify({ agentId: session.agentId, sessionId: session.id }),
      }),
    ).roomId
  attempt.importedRoomId = importedRoomId

  let read: Message[]
  try {
    read = await importedMessages(importedRoomId)
  } catch (error) {
    // The imported chat was deleted meanwhile: import it again.
    if (notFound(error) && mayStartOver) return again()
    throw error
  }
  const messages = read.filter((message) => textOf(message))
  const title = (session.title.trim() || `From ${session.sourceLabel}`).slice(0, 200)
  if (!attempt.job) {
    attempt.job = JobSchema.parse(
      await keyedWrite(attempt, 'create-job', `rooms/${encodeURIComponent(teamRoomId)}/jobs`, {
        title,
      }),
    )
  }
  const job = attempt.job

  let attached = 0
  for (const message of messages) {
    if (attempt.sharedMessageIds.has(message.id)) continue
    try {
      await keyedWrite(
        attempt,
        `share:${message.id}`,
        `messages/${encodeURIComponent(message.id)}/share`,
        { jobId: job.id },
      )
    } catch (error) {
      if (!notFound(error)) throw error
      // A 404 is either the job (deleted meanwhile: start over with a new one) or this one message (gone: skip it).
      if (!(await jobStillThere(teamRoomId, job.id))) {
        if (mayStartOver) return again()
        throw error
      }
      attempt.sharedMessageIds.add(message.id)
      continue
    }
    attempt.sharedMessageIds.add(message.id)
    attached += 1
  }
  return { job, importedRoomId, attached }
}

export function usePreviewOutsideSession() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: (session: OutsideSession) => previewOutsideSession(session),
    onSuccess: () => {
      void queryClient.invalidateQueries({ queryKey: ['outside-sessions'] })
    },
  })
}

export function useBringOutsideSessionIntoJob() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({
      session,
      teamRoomId,
      attempt,
    }: {
      session: OutsideSession
      teamRoomId: string
      attempt: BringOutsideSessionAttempt
    }) => bringOutsideSessionIntoJob(session, teamRoomId, attempt),
    onSuccess: (result, { teamRoomId }) => {
      void queryClient.invalidateQueries({ queryKey: ['outside-sessions'] })
      // The server also emits job.upserted; refetching makes the new tab appear immediately even if the stream is
      // reconnecting.
      void queryClient.invalidateQueries({ queryKey: ['bold', 'jobs', teamRoomId] })
    },
  })
}
