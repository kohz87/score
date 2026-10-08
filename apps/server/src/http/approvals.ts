import { ApprovalChoiceSchema, type Approval } from '@score/contract'
import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { requestIdempotency } from './idempotency.ts'
import { humanGuard } from '../auth/human.ts'
import type { ScoreDb } from '../db/index.ts'
import { HttpError } from '../errors.ts'
import type { Ingest } from '../hub/ingest.ts'
import { snapshot } from '../hub/snapshot.ts'
import { redactBounded } from '../redact.ts'
import type { ApprovalOutbox } from '../domain/approval-outbox.ts'
import {
  actionable,
  approvalDraft,
  ApprovalRowSchema,
  approvalView,
  readApprovalRow,
  readDelivery,
  refreshApproval,
  routeFeature,
} from '../domain/approval-store.ts'

const CursorSchema = z.tuple([z.iso.datetime(), z.string().min(1)])
const QuerySchema = z.object({
  status: z.enum(['pending', 'all']).default('pending'),
  agent: z.string().min(1).max(64).optional(),
  cursor: z
    .string()
    .max(1024)
    .regex(/^[A-Za-z0-9_-]+$/)
    .optional(),
})
const DecisionSchema = z.object({
  choice: ApprovalChoiceSchema,
  note: z.string().max(500).optional(),
})
export function registerApprovalRoutes(
  app: FastifyInstance,
  deps: {
    db: ScoreDb
    ingest: Ingest
    outbox: ApprovalOutbox
    disabled: () => readonly string[]
    clock?: () => number
  },
): void {
  const { db, ingest, outbox, disabled, clock = Date.now } = deps
  app.get('/api/approvals', async (request) => {
    const query = QuerySchema.parse(request.query)
    let cursor: z.infer<typeof CursorSchema> | undefined
    if (query.cursor) {
      try {
        cursor = CursorSchema.parse(
          JSON.parse(Buffer.from(query.cursor, 'base64url').toString('utf8')),
        )
      } catch {
        throw new HttpError(400, 'validation_error', 'Invalid cursor')
      }
    }
    const result = snapshot(db, (sqlite) => {
      const rows = z.array(ApprovalRowSchema).parse(
        sqlite
          .prepare(
            `SELECT * FROM approvals WHERE visible = 1
        AND (? = 'all' OR phase IN ('guardian_evaluating','human_pending')) AND (? IS NULL OR profile = ?)
        AND (? IS NULL OR created_at < ? OR (created_at = ? AND id < ?)) ORDER BY created_at DESC, id DESC LIMIT 51`,
          )
          .all(
            query.status,
            query.agent ?? null,
            query.agent ?? null,
            cursor?.[0] ?? null,
            cursor?.[0] ?? null,
            cursor?.[0] ?? null,
            cursor?.[1] ?? null,
          ),
      )
      const page = rows.slice(0, 50)
      const last = page.at(-1)
      return {
        items: page.map((row) => approvalView(sqlite, row, { now: clock(), disabled: disabled() })),
        nextCursor:
          rows.length > 50 && last
            ? Buffer.from(JSON.stringify([last.created_at, last.id])).toString('base64url')
            : null,
      }
    })
    return { asOfSeq: result.asOfSeq, ...result.data }
  })
  const receipts = requestIdempotency(db, clock)
  app.post(
    '/api/approvals/:approvalId/decision',
    { preHandler: [humanGuard(app.pairing), receipts.preHandler], onSend: receipts.onSend },
    async (request, reply) => {
      const { approvalId } = z
        .object({ approvalId: z.string().min(1).max(256) })
        .parse(request.params)
      const body = DecisionSchema.safeParse(request.body)
      if (!body.success) throw new HttpError(400, 'validation_error', 'Invalid decision')
      const { choice, note } = body.data
      let result: Approval | undefined
      let producerId: string | undefined
      await ingest.submit({
        source: 'approval-decision',
        identity: randomUUID(),
        apply({ sqlite, now }) {
          const row = readApprovalRow(sqlite, approvalId)
          if (!row?.visible) throw new HttpError(404, 'not_found', 'Unknown approval')
          const feature = routeFeature(row)
          if (feature && disabled().includes(feature))
            throw new HttpError(403, 'feature_disabled', 'Approval route is disabled')
          const options = { now: clock(), disabled: disabled() }
          const current = approvalView(sqlite, row, options)
          const delivery = readDelivery(sqlite, approvalId)
          if (!actionable(sqlite, row, options) || (delivery && delivery.choice !== choice))
            throw new HttpError(409, 'conflict', 'Approval cannot accept this decision', current)
          if (!row.choices.includes(choice))
            throw new HttpError(400, 'validation_error', 'Choice is not offered')
          if (delivery)
            sqlite
              .prepare(
                `UPDATE approval_deliveries SET state = 'intent', cycle = cycle + 1, cycle_attempts = 0, next_attempt_at = NULL, error = NULL, lease_id = NULL, lease_until = NULL, updated_at = ? WHERE id = ?`,
              )
              .run(now, delivery.id)
          else
            sqlite
              .prepare(
                `INSERT INTO approval_deliveries (id, approval_id, choice, note, route, producer_id, state, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, 'intent', ?, ?)`,
              )
              .run(
                randomUUID(),
                row.id,
                choice,
                note === undefined ? null : redactBounded(note, 2000).slice(0, 500),
                row.target_kind === 'gateway_request' ? 'bridge' : 'port',
                row.target_kind === 'gateway_request' ? row.producer_id : null,
                now,
                now,
              )
          producerId =
            row.target_kind === 'gateway_request' ? (row.producer_id ?? undefined) : undefined
          refreshApproval(sqlite, row.id, now)
          result = approvalView(sqlite, readApprovalRow(sqlite, row.id)!, options)
          return approvalDraft(sqlite, row.id, options)
        },
      })
      outbox.wake(producerId)
      return reply.code(202).send(result)
    },
  )
}
