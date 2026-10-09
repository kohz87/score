import type { DatabaseSync } from 'node:sqlite'
import { RoomProjectSchema, type RoomProject } from '@score/contract'
import { z } from 'zod'
import { HttpError } from '../errors.ts'
import type { DomainEventDraft } from '../hub/ingest.ts'
import { readRoom, roomChanged, roomIds, roomRow } from './rooms.ts'

const RowSchema = z.object({ id: z.string(), name: z.string(), color: z.string() })

export function listProjects(sqlite: DatabaseSync): RoomProject[] {
  return z
    .array(RowSchema)
    .parse(sqlite.prepare('SELECT id, name, color FROM room_projects ORDER BY name, id').all())
    .map((row) => RoomProjectSchema.parse(row))
}

function projectRow(sqlite: DatabaseSync, id: string): RoomProject {
  const row = sqlite.prepare('SELECT id, name, color FROM room_projects WHERE id = ?').get(id)
  if (!row) throw new HttpError(404, 'not_found', 'Unknown project')
  return RoomProjectSchema.parse(RowSchema.parse(row))
}

function assertNameFree(sqlite: DatabaseSync, name: string, exceptId: string | null): void {
  const clash = sqlite
    .prepare('SELECT id FROM room_projects WHERE name = ? COLLATE NOCASE AND id IS NOT ?')
    .get(name, exceptId)
  if (clash) throw new HttpError(409, 'conflict', 'A project with that name already exists')
}

export function createProject(
  sqlite: DatabaseSync,
  project: RoomProject,
  now: string,
): DomainEventDraft[] {
  assertNameFree(sqlite, project.name, null)
  sqlite
    .prepare('INSERT INTO room_projects (id, name, color, created_at) VALUES (?, ?, ?, ?)')
    .run(project.id, project.name, project.color, now)
  return [{ type: 'room-project.upserted', data: project }]
}

export function updateProject(
  sqlite: DatabaseSync,
  id: string,
  patch: { name?: string | undefined; color?: string | undefined },
): DomainEventDraft[] {
  const current = projectRow(sqlite, id)
  const next = { id, name: patch.name ?? current.name, color: patch.color ?? current.color }
  if (next.name !== current.name) assertNameFree(sqlite, next.name, id)
  sqlite
    .prepare('UPDATE room_projects SET name = ?, color = ? WHERE id = ?')
    .run(next.name, next.color, id)
  return [{ type: 'room-project.upserted', data: RoomProjectSchema.parse(next) }]
}

/** Rooms in a deleted project simply leave it. */
export function deleteProject(sqlite: DatabaseSync, id: string, now: string): DomainEventDraft[] {
  projectRow(sqlite, id)
  const members = roomIds(sqlite).filter((roomId) => roomRow(sqlite, roomId).project_id === id)
  const events: DomainEventDraft[] = []
  for (const roomId of members) {
    const before = readRoom(sqlite, roomId, roomRow(sqlite, roomId).updated_at)
    sqlite.prepare('UPDATE rooms SET project_id = NULL WHERE id = ?').run(roomId)
    events.push(...roomChanged(sqlite, roomId, now, before))
  }
  sqlite.prepare('DELETE FROM room_projects WHERE id = ?').run(id)
  events.push({ type: 'room-project.deleted', data: { id } })
  return events
}

export function assertProject(sqlite: DatabaseSync, id: string): void {
  projectRow(sqlite, id)
}
