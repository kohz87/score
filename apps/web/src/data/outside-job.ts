import {
  ImportSessionResponseSchema,
  JobSchema,
  MessagePageSchema,
  type Job,
  type Message,
  type OutsideSession,
} from '@score/contract'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { apiFetch } from './api.ts'
import { newId } from './ids.ts'

export interface BringOutsideSessionIntoJobResult {
  job: Job
  importedRoomId: string
  attached: number
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
  return [...items.values()].sort(
    (left, right) =>
      left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id),
  )
}

/**
 * The contract has no single "attach this outside chat to a job" call. Its pieces do fit together: import the session
 * as a read-only room, make a team job, then share each imported text message into it as the frozen copy the share
 * endpoint defines. The import is capped at 1000 messages; the job is a team-room job, as the prototype says.
 */
export async function bringOutsideSessionIntoJob(
  session: OutsideSession,
  teamRoomId: string,
): Promise<BringOutsideSessionIntoJobResult> {
  const imported = ImportSessionResponseSchema.parse(
    await apiFetch('outside-sessions/import', {
      method: 'POST',
      body: JSON.stringify({ agentId: session.agentId, sessionId: session.id }),
    }),
  )
  const messages = await importedMessages(imported.roomId)
  const title = (session.title.trim() || `From ${session.sourceLabel}`).slice(0, 200)
  const job = JobSchema.parse(
    await apiFetch(`rooms/${encodeURIComponent(teamRoomId)}/jobs`, {
      method: 'POST',
      headers: { 'Idempotency-Key': newId() },
      body: JSON.stringify({ title }),
    }),
  )

  let attached = 0
  for (const message of messages) {
    if (!textOf(message)) continue
    await apiFetch(`messages/${encodeURIComponent(message.id)}/share`, {
      method: 'POST',
      body: JSON.stringify({ jobId: job.id }),
    })
    attached += 1
  }
  return { job, importedRoomId: imported.roomId, attached }
}

export function useBringOutsideSessionIntoJob() {
  const queryClient = useQueryClient()
  return useMutation({
    mutationFn: ({ session, teamRoomId }: { session: OutsideSession; teamRoomId: string }) =>
      bringOutsideSessionIntoJob(session, teamRoomId),
    onSuccess: (result, { teamRoomId }) => {
      void queryClient.invalidateQueries({ queryKey: ['outside-sessions'] })
      // The server also emits job.upserted; refetching makes the new tab appear immediately even if the stream is
      // reconnecting.
      void queryClient.invalidateQueries({ queryKey: ['bold', 'jobs', teamRoomId] })
    },
  })
}
