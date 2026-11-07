import type { DatabaseSync } from 'node:sqlite'
import { ReportBackSchema, TriggerMappingSchema, type Trigger } from '@score/contract'
import { z } from 'zod'
import { HttpError } from '../../errors.ts'
import { reportBackWarning } from './report-back.ts'

// Trigger rows: the database shape, reads, and the contract view every trigger operation works with.

export const RowSchema = z.object({
  id: z.string(),
  name: z.string(),
  app: z.string(),
  secret_sealed: z.string(),
  mapping: z.string(),
  template: z.string(),
  report_back: z.string(),
  sample: z.string().nullable(),
  created_at: z.string(),
  last_called_at: z.string().nullable(),
  deleted_at: z.string().nullable(),
  team_room_id: z.string().nullable().default(null),
})
export type Row = z.infer<typeof RowSchema>

export const context = (id: string) => `trigger:${id}`

export function row(sqlite: DatabaseSync, id: string): Row | null {
  const value = sqlite.prepare('SELECT * FROM triggers WHERE id = ?').get(id)
  return value === undefined ? null : RowSchema.parse(value)
}

export function toTrigger(item: Row, origin: string | null): Trigger {
  const reportBack = ReportBackSchema.parse(JSON.parse(item.report_back))
  const warning = reportBack.mode === 'off' ? undefined : reportBackWarning(reportBack.tool)
  return {
    id: item.id,
    name: item.name,
    app: item.app,
    mapping: TriggerMappingSchema.parse(JSON.parse(item.mapping)),
    template: item.template,
    reportBack,
    url: origin ? `${origin}/hooks/${item.id}` : null,
    sample: item.sample === null ? null : (JSON.parse(item.sample) as unknown),
    lastCalledAt: item.last_called_at,
    createdAt: item.created_at,
    teamRoomId: item.team_room_id,
    ...(warning ? { warning } : {}),
  }
}

export function live(sqlite: DatabaseSync, id: string): Row {
  const found = row(sqlite, id)
  if (!found || found.deleted_at)
    throw new HttpError(404, 'not_found', 'Couldn’t find that trigger.')
  return found
}
