import {
  DirectChatsResponseSchema,
  JobSchema,
  PostMessageResponseSchema,
  type Job,
  type Room,
} from '@score/contract'
import { apiFetch } from '../../data/api.ts'
import { newId } from '../../data/ids.ts'
import { defineStreamQuery } from '../../data/resync.ts'

export type DirectChatsState = { room: Room | null; chats: Job[] }

const newest = (chat: Job) => chat.lastMessageAt ?? chat.createdAt
const byActivity = (a: Job, b: Job) =>
  newest(b).localeCompare(newest(a)) ||
  b.createdAt.localeCompare(a.createdAt) ||
  b.id.localeCompare(a.id)

/** One agent's one-to-one home and every chat in it (PLAN 11.7), newest activity first. */
export function directChatsQuery(agentId: string) {
  return defineStreamQuery<DirectChatsState>({
    key: ['bold', 'direct', agentId],
    async fetch(signal) {
      const response = DirectChatsResponseSchema.parse(
        await apiFetch(`agents/${encodeURIComponent(agentId)}/direct`, { signal }),
      )
      return {
        asOfSeq: response.asOfSeq,
        data: { room: response.room, chats: [...response.chats].sort(byActivity) },
      }
    },
    types: ['room.upserted', 'room.deleted', 'job.upserted'],
    reduce(data, event) {
      if (event.type === 'room.deleted')
        return data.room?.id === event.data.id ? { room: null, chats: [] } : data
      if (event.type === 'room.upserted') {
        if (event.data.kind !== 'direct' || event.data.leadAgentId !== agentId) return data
        return { ...data, room: event.data }
      }
      if (event.type !== 'job.upserted') return data
      if (data.room && event.data.roomId !== data.room.id) return data
      const chat = JobSchema.parse(event.data)
      return {
        ...data,
        chats: [...data.chats.filter((item) => item.id !== chat.id), chat].sort(byActivity),
      }
    },
  })
}

export async function createDirectChat(agentId: string, title?: string): Promise<Job> {
  return JobSchema.parse(
    await apiFetch(`agents/${encodeURIComponent(agentId)}/chats`, {
      method: 'POST',
      headers: { 'Idempotency-Key': newId() },
      body: JSON.stringify(title ? { title } : {}),
    }),
  )
}

/** Posts a frozen copy of one message into a job in the team room (PLAN 11.2 §6.4). */
export async function shareMessageToJob(messageId: string, jobId: string): Promise<void> {
  // The created copy reaches the room as `job.upserted`/a message event; this action only needs the refusal.
  await apiFetch(`messages/${encodeURIComponent(messageId)}/share`, {
    method: 'POST',
    headers: { 'Idempotency-Key': newId() },
    body: JSON.stringify({ jobId }),
  })
}

/** Step one of Add someone: a team-room job named for the chat. */
export async function createTeamJob(teamRoomId: string, chat: Job): Promise<Job> {
  return JobSchema.parse(
    await apiFetch(`rooms/${encodeURIComponent(teamRoomId)}/jobs`, {
      method: 'POST',
      headers: { 'Idempotency-Key': newId() },
      body: JSON.stringify({ title: chat.title || 'New chat' }),
    }),
  )
}

/** Step two: one message in that job addressed to `to`, carrying the chat as a frozen reference. */
export async function postChatHandOff(
  teamRoomId: string,
  jobId: string,
  chat: Job,
  to: readonly string[],
): Promise<void> {
  const added = to.at(-1) ?? ''
  PostMessageResponseSchema.parse(
    await apiFetch(`rooms/${encodeURIComponent(teamRoomId)}/messages`, {
      method: 'POST',
      headers: { 'Idempotency-Key': newId() },
      body: JSON.stringify({
        text: `@${added} Let’s continue this chat with the team.`,
        to: [...to],
        jobId,
        refs: [{ jobId: chat.id }],
      }),
    }),
  )
}

/**
 * A direct room holds one agent, so the contract has no route to add a member. Adding someone turns the conversation
 * into a team-room job with the chat referenced, not copied: create the job, then post one addressed message carrying
 * `refs: [{ jobId: chat.id }]` (PLAN 11.0 §6.1).
 */
export async function moveChatToTeamRoom(
  teamRoomId: string,
  chat: Job,
  to: readonly string[],
): Promise<Job> {
  const job = await createTeamJob(teamRoomId, chat)
  await postChatHandOff(teamRoomId, job.id, chat, to)
  return job
}
