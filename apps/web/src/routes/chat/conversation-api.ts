import { RoomProjectSchema, type AutoSummary, type RoomProject } from '@score/contract'
import { apiFetch } from '../../data/api.ts'
import { newId } from '../../data/ids.ts'

export type RoomOrganise = {
  name?: string
  pinned?: boolean
  archived?: boolean
  projectId?: string | null
  tags?: string[] | null
  autoSummary?: AutoSummary
}

// The room's new state arrives on the stream as `room.upserted`.
export function patchRoom(roomId: string, body: RoomOrganise): Promise<unknown> {
  return apiFetch(`rooms/${encodeURIComponent(roomId)}`, {
    method: 'PATCH',
    headers: { 'Idempotency-Key': newId() },
    body: JSON.stringify(body),
  })
}

export async function createProject(body: { name: string; color: string }): Promise<RoomProject> {
  return RoomProjectSchema.parse(
    await apiFetch('room-projects', { method: 'POST', body: JSON.stringify(body) }),
  )
}
export async function updateProject(
  id: string,
  body: { name?: string; color?: string },
): Promise<RoomProject> {
  return RoomProjectSchema.parse(
    await apiFetch(`room-projects/${encodeURIComponent(id)}`, {
      method: 'PATCH',
      body: JSON.stringify(body),
    }),
  )
}
export async function deleteProject(id: string): Promise<void> {
  await apiFetch(`room-projects/${encodeURIComponent(id)}`, { method: 'DELETE' })
}

export const PROJECT_COLORS = [
  { value: '#6B4EFF', label: 'Violet' },
  { value: '#19C39A', label: 'Jade' },
  { value: '#FFB61E', label: 'Saffron' },
  { value: '#FF6B8A', label: 'Coral' },
  { value: '#12131A', label: 'Ink' },
  { value: '#8A909B', label: 'Grey' },
] as const

/** "q4, #urgent Q1" → ['q4', 'urgent', 'q1'] (valid tags only; the server validates again). */
export function parseTagInput(text: string): string[] {
  const tags = text
    .split(/[\s,]+/)
    .map((word) => word.replace(/^#/, '').toLowerCase())
    .filter((word) => /^[a-z0-9][a-z0-9-]{0,31}$/.test(word))
  return [...new Set(tags)]
}

// Room summary (PLAN 7.4a). The new message arrives on the stream (`message.created`, `message.updated`).
const summaryUrl = (roomId: string) => `rooms/${encodeURIComponent(roomId)}/summary`
export function regenerateSummary(roomId: string): Promise<unknown> {
  return apiFetch(summaryUrl(roomId), {
    method: 'POST',
    headers: { 'Idempotency-Key': newId() },
    body: '{}',
  })
}
export function editSummary(roomId: string, text: string): Promise<unknown> {
  return apiFetch(summaryUrl(roomId), {
    method: 'PATCH',
    headers: { 'Idempotency-Key': newId() },
    body: JSON.stringify({ text }),
  })
}
export function deleteSummary(roomId: string): Promise<unknown> {
  return apiFetch(summaryUrl(roomId), { method: 'DELETE' })
}
