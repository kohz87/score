import type { DatabaseSync } from 'node:sqlite'
import { ExchangeRowSchema, JobRowSchema, type ExchangeRow, type JobRow } from './row-schemas.ts'

export const EXCHANGE_SELECT =
  'SELECT x.*, j.room_id FROM exchanges x JOIN jobs j ON j.id = x.job_id'

export function jobRow(sqlite: DatabaseSync, jobId: string): JobRow | null {
  const row = sqlite.prepare('SELECT * FROM jobs WHERE id = ?').get(jobId)
  return row === undefined ? null : JobRowSchema.parse(row)
}

export function exchangeRow(sqlite: DatabaseSync, id: string): ExchangeRow | null {
  const row = sqlite.prepare(`${EXCHANGE_SELECT} WHERE x.id = ?`).get(id)
  return row === undefined ? null : ExchangeRowSchema.parse(row)
}
