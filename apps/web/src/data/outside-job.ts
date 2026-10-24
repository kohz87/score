import {
  ImportSessionResponseSchema,
  JobSchema,
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
}

export function newBringOutsideSessionAttempt(
  importedRoomId: string | null = null,
): BringOutsideSessionAttempt {
  return {
    importedRoomId,
    job: null,
    sharedMessageIds: new Set(),
    pendingKeys: new Map(),
  }
}

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
    return result
  } catch (error) {
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
  try {
    return await bringOnce(session, teamRoomId, attempt)
  } catch (error) {
    // The job or the imported chat this attempt kept was deleted meanwhile: start over once rather than retrying a
    // state that can't work any more.
    const kept = attempt.job !== null || attempt.importedRoomId !== null
    if (!(error instanceof ApiError && error.status === 404 && kept)) throw error
    attempt.job = null
    attempt.importedRoomId = null
    attempt.sharedMessageIds.clear()
    attempt.pendingKeys.clear()
    return bringOnce(session, teamRoomId, attempt)
  }
}

async function bringOnce(
  session: OutsideSession,
  teamRoomId: string,
  attempt: BringOutsideSessionAttempt,
): Promise<BringOutsideSessionIntoJobResult> {
  const importedRoomId =
    attempt.importedRoomId ??
    ImportSessionResponseSchema.parse(
      await apiFetch('outside-sessions/import', {
        method: 'POST',
        body: JSON.stringify({ agentId: session.agentId, sessionId: session.id }),
      }),
    ).roomId
  attempt.importedRoomId = importedRoomId

  const messages = (await importedMessages(importedRoomId)).filter((message) => textOf(message))
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
    await keyedWrite(
      attempt,
      `share:${message.id}`,
      `messages/${encodeURIComponent(message.id)}/share`,
      { jobId: job.id },
    )
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
