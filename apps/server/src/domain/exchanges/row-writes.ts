import { randomBytes } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import type { Job } from '@score/contract'
import type { DomainEventDraft } from '../../hub/ingest.ts'
import { exchangeEvent } from './exchange-view.ts'
import { jobEvent } from './job-view.ts'
import { jobRow } from './row-reads.ts'
import type { ExchangeRow } from './row-schemas.ts'

/** Changes a job's holder and/or state; returns the event when anything changed. */
export function updateJob(
  sqlite: DatabaseSync,
  jobId: string,
  change: { holder?: string; state?: Job['state'] },
  now: string,
): DomainEventDraft[] {
  const before = jobRow(sqlite, jobId)
  if (!before) return []
  const holder = change.holder ?? before.holder_agent_id
  // A closed job stays closed whatever settles in it afterwards (Stop, a late turn): only Reopen opens it.
  const state = before.state === 'closed' ? 'closed' : (change.state ?? before.state)
  if (holder === before.holder_agent_id && state === before.state) return []
  sqlite
    .prepare(
      'UPDATE jobs SET holder_agent_id = ?, state = ?, updated_at = ?, version = version + 1 WHERE id = ?',
    )
    .run(holder, state, now, jobId)
  return jobEvent(sqlite, jobId)
}

export function updateExchange(
  sqlite: DatabaseSync,
  id: string,
  change: Partial<
    Pick<
      ExchangeRow,
      | 'state'
      | 'round'
      | 'outcome'
      | 'ended_reason'
      | 'pause_reason'
      | 'held'
      | 'decider_turn_id'
      | 'budget'
      | 'lead_extended'
    >
  >,
  now: string,
): DomainEventDraft[] {
  const sets = Object.keys(change).map((key) => `${key} = ?`)
  if (!sets.length) return []
  sqlite
    .prepare(
      `UPDATE exchanges SET ${sets.join(', ')}, updated_at = ?, version = version + 1 WHERE id = ?`,
    )
    .run(...Object.values(change), now, id)
  // 3.30.1: the job's `needsYou` follows its exchanges, so the job is sent again with them.
  const jobId = (
    sqlite.prepare('SELECT job_id FROM exchanges WHERE id = ?').get(id) as
      { job_id: string } | undefined
  )?.job_id
  return [...exchangeEvent(sqlite, id), ...(jobId ? jobEvent(sqlite, jobId) : [])]
}

export function openExchange(
  sqlite: DatabaseSync,
  req: {
    jobId: string
    kind: ExchangeRow['kind']
    parentId: string | null
    from: string
    to: string
    turnId: string
  },
  now: string,
): string {
  const job = jobRow(sqlite, req.jobId)
  if (!job) throw new Error(`job ${req.jobId} not found`)
  const id = `xch_${randomBytes(12).toString('hex')}`
  sqlite
    .prepare(
      `INSERT INTO exchanges (id, job_id, kind, parent_id, from_agent_id, to_agent_id, state, budget, opened_by_turn_id,
         created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, 'live', ?, ?, ?, ?)`,
    )
    .run(
      id,
      req.jobId,
      req.kind,
      req.parentId,
      req.from,
      req.to,
      job.exchange_budget,
      req.turnId,
      now,
      now,
    )
  return id
}
