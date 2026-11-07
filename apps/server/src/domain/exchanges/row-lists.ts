import type { DatabaseSync } from 'node:sqlite'
import type { Exchange, Job } from '@score/contract'
import { z } from 'zod'
import { exchangeFromRow } from './exchange-view.ts'
import { jobFromRow } from './job-view.ts'
import { EXCHANGE_SELECT } from './row-reads.ts'
import { ExchangeRowSchema, JobRowSchema } from './row-schemas.ts'

/** The room's jobs, the default first; closed ones only when asked (`closed`: the job menu's "Closed jobs"). */
export function listJobs(sqlite: DatabaseSync, roomId: string, { closed = false } = {}): Job[] {
  return z
    .array(JobRowSchema)
    .parse(
      sqlite
        .prepare(
          `SELECT * FROM jobs WHERE room_id = ? AND deleted_at IS NULL ${closed ? '' : "AND state != 'closed'"}
           ORDER BY is_default DESC, created_at, id`,
        )
        .all(roomId),
    )
    .map((row) => jobFromRow(sqlite, row))
}

export function listExchanges(sqlite: DatabaseSync, jobId: string): Exchange[] {
  return z
    .array(ExchangeRowSchema)
    .parse(
      sqlite
        .prepare(`${EXCHANGE_SELECT} WHERE x.job_id = ? ORDER BY x.created_at, x.id`)
        .all(jobId),
    )
    .map((row) => exchangeFromRow(sqlite, row))
}
