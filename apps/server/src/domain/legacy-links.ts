import type { TaskDetail } from '@score/contract'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { decodeReceipt, encodeReceipt } from '../receipt-codec.ts'
import { kanbanAttemptsEnabled } from './kanban-attempts.ts'
import { actionableHistoryId } from './ownership.ts'

// Legacy numeric run links of a task (5.17a-1, design v5 §E). Before attempts had their own identity a task listed
// Hermes's numeric attempt ids. With attempts on, the numeric ids are replaced: a link that stage 1 proved maps to the
// attempt's opaque id, every other legacy link is reported as unresolved, and a numeric id first seen after the
// upgrade maps through the lineage Score follows (or is dropped when Score has no such attempt, e.g. a synthetic row).

const LinkRowSchema = z.object({
  legacy_id: z.string(),
  status: z.enum(['pending', 'mapped', 'unresolved']),
  attempt_key: z.string().nullable(),
  reason: z.string().nullable(),
})

const isNumeric = (id: string) => /^\d+$/.test(id)

export interface MappedRunIds {
  runIds: string[]
  unresolvedRunLinks: { legacyId: string; reason: string }[]
}

export function mapRunIds(
  sqlite: DatabaseSync,
  taskId: string,
  runIds: readonly string[],
): MappedRunIds {
  const links = z
    .array(LinkRowSchema)
    .parse(
      sqlite
        .prepare(
          'SELECT legacy_id, status, attempt_key, reason FROM kanban_upgrade_links WHERE task_id = ? ORDER BY legacy_id',
        )
        .all(taskId),
    )
  const byLegacy = new Map(links.map((link) => [link.legacy_id, link]))
  const out = new Set(runIds.filter((id) => !isNumeric(id)))
  const history = actionableHistoryId(sqlite)
  for (const id of runIds) {
    if (!isNumeric(id) || byLegacy.has(id)) continue
    const attempt =
      history === null
        ? undefined
        : (sqlite
            .prepare(
              'SELECT id FROM kanban_attempts WHERE history_id = ? AND task_id = ? AND attempt_id = ?',
            )
            .get(history, taskId, Number(id)) as { id: string } | undefined)
    if (attempt) out.add(attempt.id)
  }
  const unresolved: MappedRunIds['unresolvedRunLinks'] = []
  for (const link of links) {
    if (link.status === 'mapped' && link.attempt_key) out.add(link.attempt_key)
    else if (link.status === 'unresolved')
      unresolved.push({ legacyId: link.legacy_id, reason: link.reason ?? 'unresolved' })
    else if (link.status === 'pending')
      unresolved.push({ legacyId: link.legacy_id, reason: 'not_yet_resolved' })
  }
  return { runIds: [...out], unresolvedRunLinks: unresolved }
}

/** The task as served: legacy ids resolved and `unresolvedRunLinks` present. Identity with attempts off. */
export function withRunLinks(sqlite: DatabaseSync, detail: TaskDetail): TaskDetail {
  if (!kanbanAttemptsEnabled()) return detail
  return { ...detail, ...mapRunIds(sqlite, detail.id, detail.runIds) }
}

const ReceiptRowSchema = z.object({ key: z.string(), route: z.string(), response: z.string() })
const ReceiptBodySchema = z.looseObject({ id: z.string(), runIds: z.array(z.string()) })

/**
 * Rewrites stored idempotency receipts of the given tasks so their task details carry the resolved links. The receipt
 * itself (its status and "already executed" marker) is never deleted, so the mutation can't run again. Returns how many
 * receipts changed.
 */
export function rewriteReceipts(sqlite: DatabaseSync, taskIds: readonly string[]): number {
  if (!taskIds.length) return 0
  const wanted = new Set(taskIds)
  const rows = z.array(ReceiptRowSchema).parse(
    sqlite
      .prepare(
        `SELECT key, route, response FROM request_receipts
            WHERE response IS NOT NULL AND (route = '/api/tasks' OR route LIKE '/api/tasks/%')`,
      )
      .all(),
  )
  let changed = 0
  const update = sqlite.prepare(
    'UPDATE request_receipts SET response = ? WHERE key = ? AND route = ?',
  )
  for (const row of rows) {
    let body: z.infer<typeof ReceiptBodySchema>
    try {
      const parsed = ReceiptBodySchema.safeParse(decodeReceipt(row.response, 524288))
      if (!parsed.success || !wanted.has(parsed.data.id)) continue
      body = parsed.data
    } catch {
      continue
    }
    const mapped = mapRunIds(sqlite, body.id, body.runIds)
    const next = JSON.stringify({ ...body, ...mapped })
    if (next === JSON.stringify(body)) continue
    try {
      update.run(encodeReceipt(next, row.route), row.key, row.route)
      changed++
    } catch {
      // Too large to store: the old receipt stays (it still blocks a rerun); the served detail is already resolved.
    }
  }
  return changed
}
