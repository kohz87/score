import type { DatabaseSync } from 'node:sqlite'
import { RoomProjectSchema, type RoomProject } from '@score/contract'
import { z } from 'zod'
import { HttpError } from '../errors.ts'
import type { DomainEventDraft } from '../hub/ingest.ts'

const RowSchema = z.object({ id: z.string(), name: z.string(), color: z.string() })

export function listProjects(sqlite: DatabaseSync): RoomProject[] {
  return z
    .array(RowSchema)
    .parse(sqlite.prepare('SELECT id, name, color FROM room_projects ORDER BY name, id').all())
    .map((row) => RoomProjectSchema.parse(row))
}

function projectRow(sqlite: DatabaseSync, id: string): RoomProject {
  const row = sqlite.prepare('SELECT id, name, color FROM room_projects WHERE id = ?').get(id)
  if (!row) throw new HttpError(404, 'not_found', 'Couldn’t find that project.')
  return RoomProjectSchema.parse(RowSchema.parse(row))
}

function assertNameFree(sqlite: DatabaseSync, name: string, exceptId: string | null): void {
  const clash = sqlite
    .prepare('SELECT id FROM room_projects WHERE name = ? COLLATE NOCASE AND id IS NOT ?')
    .get(name, exceptId)
  if (clash) throw new HttpError(409, 'conflict', 'A project with that name already exists.')
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

export function assertProject(sqlite: DatabaseSync, id: string): void {
  projectRow(sqlite, id)
}
