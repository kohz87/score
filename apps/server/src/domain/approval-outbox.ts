import { BridgeDecisionAckRequestSchema, type BridgeDecision } from '@score/contract'
import { randomUUID } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import type { ScoreDb } from '../db/index.ts'
import { HttpError } from '../errors.ts'
import { ApprovalDeliveryError, type HermesPort } from '../hermes/index.ts'
import type { Ingest, DomainEventDraft } from '../hub/ingest.ts'
import {
  actionable,
  approvalDraft,
  deliverable,
  DeliveryRowSchema,
  patchApproval,
  readApprovalRow,
  readDelivery,
  refreshApproval,
  type DeliveryRow,
} from './approval-store.ts'

export function finishDelivery(
  sqlite: DatabaseSync,
  delivery: DeliveryRow,
  state: DeliveryRow['state'],
  at: string,
  error: string | null = null,
): DomainEventDraft[] {
  const current = readDelivery(sqlite, delivery.approval_id)!
  if (current.state === 'applied' && state !== 'applied') return []
  let next = state
  if (current.maybe_applied && ['failed', 'not_pending'].includes(next)) next = 'unknown'
  const row = readApprovalRow(sqlite, current.approval_id)!
  if (next === 'applied')
    sqlite.prepare('UPDATE approval_deliveries SET maybe_applied = 1 WHERE id = ?').run(current.id)
  if (next === 'applied' && row.decision_choice && row.decision_choice !== current.choice) {
    next = 'unknown'
    error = 'choice_mismatch'
  }
  sqlite
    .prepare(
      'UPDATE approval_deliveries SET state = ?, error = ?, updated_at = ?, next_attempt_at = NULL WHERE id = ?',
    )
    .run(next, error, at, current.id)
  if (next === 'applied')
    patchApproval(
      sqlite,
      row.id,
      { decision_choice: current.choice, decision_by: 'you', decided_at: row.decided_at ?? at },
      at,
    )
  else refreshApproval(sqlite, row.id, at)
  return approvalDraft(sqlite, row.id, { now: Date.parse(at) })
}

// The receipt's first negative answer is a proof of non-application, despite issuing its lease
// conservatively setting maybe_applied. Later attempts have no such proof.
function firstBridgeNotPending(
  sqlite: DatabaseSync,
  delivery: DeliveryRow,
  at: string,
): DomainEventDraft[] {
  sqlite
    .prepare(
      `UPDATE approval_deliveries SET state = 'not_pending', error = NULL, updated_at = ? WHERE id = ?`,
    )
    .run(at, delivery.id)
  refreshApproval(sqlite, delivery.approval_id, at)
  return approvalDraft(sqlite, delivery.approval_id, { now: Date.parse(at) })
}

export class ApprovalNotifier {
  private readonly listeners = new Map<string, Set<() => void>>()
  private readonly revisions = new Map<string, number>()
  private closed = false
  revision(producerId: string): number {
    return this.revisions.get(producerId) ?? 0
  }
  wake(producerId: string): void {
    this.revisions.set(producerId, this.revision(producerId) + 1)
    for (const listener of this.listeners.get(producerId) ?? []) listener()
  }
  wait(
    producerId: string,
    revision: number,
    milliseconds: number,
    signal: AbortSignal,
  ): Promise<void> {
    if (this.closed || signal.aborted || this.revision(producerId) !== revision)
      return Promise.resolve()
    return new Promise((resolve) => {
      const set = this.listeners.get(producerId) ?? new Set()
      this.listeners.set(producerId, set)
      const finish = () => {
        clearTimeout(timer)
        signal.removeEventListener('abort', finish)
        set.delete(finish)
        if (!set.size) this.listeners.delete(producerId)
        resolve()
      }
      const timer = setTimeout(finish, milliseconds)
      set.add(finish)
      signal.addEventListener('abort', finish, { once: true })
    })
  }
  close(): void {
    this.closed = true
    for (const set of this.listeners.values()) for (const finish of [...set]) finish()
  }
  /** After close, waits return at once: long-polls must stop instead of claiming in a loop. */
  get isClosed(): boolean {
    return this.closed
  }
}

export class ApprovalOutbox {
  readonly notifier = new ApprovalNotifier()
  private timer: NodeJS.Timeout | undefined
  private flight: Promise<void> | undefined
  private stopped = false
  private started = false
  constructor(
    private readonly deps: {
      db: ScoreDb
      ingest: Pick<Ingest, 'submit'>
      port: HermesPort
      clock?: () => number
      getDisabled?: () => readonly string[]
      onError?: (error: unknown) => void
    },
  ) {}
  private clock(): number {
    return (this.deps.clock ?? Date.now)()
  }
  private async change(
    work: (sqlite: DatabaseSync, at: string) => DomainEventDraft[],
  ): Promise<void> {
    await this.deps.ingest.submit({
      source: 'approval-outbox',
      identity: randomUUID(),
      apply: ({ sqlite }) => {
        const at = new Date(this.clock()).toISOString()
        const drafts = work(sqlite, at)
        const disabled = this.deps.getDisabled?.() ?? this.deps.port.status().compatibility.disabled
        return drafts.map((draft) =>
          draft.type === 'approval.requested' || draft.type === 'approval.updated'
            ? {
                ...draft,
                data: {
                  ...draft.data,
                  actionable: actionable(sqlite, readApprovalRow(sqlite, draft.data.id)!, {
                    now: Date.parse(at),
                    disabled,
                  }),
                },
              }
            : draft,
        )
      },
    })
  }
  async start(): Promise<void> {
    if (
      this.deps.db.sqlite
        .prepare(
          "SELECT 1 FROM approval_deliveries WHERE route = 'port' AND state = 'delivering' LIMIT 1",
        )
        .get()
    )
      await this.change((sqlite, at) => {
        const rows = z
          .array(DeliveryRowSchema)
          .parse(
            sqlite
              .prepare(
                `SELECT * FROM approval_deliveries WHERE route = 'port' AND state = 'delivering'`,
              )
              .all(),
          )
        return rows.flatMap((row) => {
          sqlite
            .prepare(
              `UPDATE approval_deliveries SET maybe_applied = 1, state = 'intent', next_attempt_at = NULL, updated_at = ? WHERE id = ?`,
            )
            .run(at, row.id)
          refreshApproval(sqlite, row.approval_id, at)
          return approvalDraft(sqlite, row.approval_id, { now: Date.parse(at) })
        })
      })
    this.started = true
    this.timer = setInterval(() => this.wake(), 1000)
    this.timer.unref()
    this.wake()
  }
  wake(producerId?: string): void {
    if (producerId) this.notifier.wake(producerId)
    if (this.stopped || !this.started) return
    void this.runOnce().catch((error: unknown) => this.deps.onError?.(error))
  }
  runOnce(): Promise<void> {
    if (this.flight) return this.flight
    this.flight = this.dispatch().finally(() => {
      this.flight = undefined
    })
    return this.flight
  }
  private async dispatch(): Promise<void> {
    const due = z
      .array(DeliveryRowSchema)
      .parse(
        this.deps.db.sqlite
          .prepare(
            `SELECT * FROM approval_deliveries WHERE route = 'port' AND state = 'intent' AND (next_attempt_at IS NULL OR next_attempt_at <= ?) ORDER BY created_at, id LIMIT 20`,
          )
          .all(this.clock()),
      )
    for (const candidate of due) {
      if (this.stopped) break
      let claim: DeliveryRow | undefined
      await this.change((sqlite, at) => {
        const current = readDelivery(sqlite, candidate.approval_id)!
        if (current.state !== 'intent') return []
        const row = readApprovalRow(sqlite, current.approval_id)!
        if (!deliverable(row, current, Date.parse(at)))
          return finishDelivery(sqlite, current, 'failed', at, 'not_deliverable')
        if (current.cycle_attempts >= 4)
          return finishDelivery(sqlite, current, 'failed', at, 'attempts_exhausted')
        sqlite
          .prepare(
            `UPDATE approval_deliveries SET state = 'delivering', cycle_attempts = cycle_attempts + 1, updated_at = ? WHERE id = ?`,
          )
          .run(at, current.id)
        claim = readDelivery(sqlite, current.approval_id)!
        refreshApproval(sqlite, current.approval_id, at)
        return approvalDraft(sqlite, current.approval_id, { now: Date.parse(at) })
      })
      if (!claim) continue
      const delivery = claim
      const row = readApprovalRow(this.deps.db.sqlite, delivery.approval_id)!
      try {
        const outcome = await this.deps.port.deliverDecision({
          approvalId: row.id,
          origin: row.origin,
          profile: row.profile,
          runId: row.run_id,
          requestId: row.request_id!,
          choice: delivery.choice,
        })
        await this.change((sqlite, at) =>
          finishDelivery(
            sqlite,
            delivery,
            outcome,
            at,
            outcome === 'failed' ? 'delivery_failed' : null,
          ),
        )
      } catch (error) {
        const classified =
          error instanceof ApprovalDeliveryError
            ? error
            : new ApprovalDeliveryError('delivery_error', true, true)
        await this.change((sqlite, at) => {
          const current = readDelivery(sqlite, delivery.approval_id)!
          if (current.state === 'applied') return []
          if (classified.maybeApplied)
            sqlite
              .prepare('UPDATE approval_deliveries SET maybe_applied = 1 WHERE id = ?')
              .run(current.id)
          const operation = readApprovalRow(sqlite, current.approval_id)!
          const delay = [1000, 5000, 30_000][current.cycle_attempts - 1]
          if (
            !classified.retryable ||
            delay === undefined ||
            (operation.expires_at && this.clock() + delay >= Date.parse(operation.expires_at))
          )
            return finishDelivery(sqlite, current, 'failed', at, classified.code)
          sqlite
            .prepare(
              `UPDATE approval_deliveries SET state = 'intent', next_attempt_at = ?, error = ?, updated_at = ? WHERE id = ?`,
            )
            .run(this.clock() + delay, classified.code, at, current.id)
          refreshApproval(sqlite, current.approval_id, at)
          return approvalDraft(sqlite, current.approval_id, { now: Date.parse(at) })
        })
      }
    }
  }
  async claimBridge(producerId: string): Promise<BridgeDecision[]> {
    const items: BridgeDecision[] = []
    await this.change((sqlite, at) => {
      const now = Date.parse(at)
      sqlite.prepare('UPDATE producers SET last_seen_at = ? WHERE id = ?').run(at, producerId)
      // Only a producer qualified at its latest hello may receive decisions (gate review #2).
      if (
        !sqlite
          .prepare('SELECT 1 FROM producers WHERE id = ? AND gateway_approvals = 1')
          .get(producerId)
      )
        return []
      const rows = z
        .array(DeliveryRowSchema)
        .parse(
          sqlite
            .prepare(
              `SELECT * FROM approval_deliveries WHERE route = 'bridge' AND producer_id = ? AND (state = 'intent' OR (state = 'delivering' AND lease_until <= ?)) ORDER BY created_at, id LIMIT 20`,
            )
            .all(producerId, now),
        )
      return rows.flatMap((delivery) => {
        const row = readApprovalRow(sqlite, delivery.approval_id)!
        if (!deliverable(row, delivery, now))
          return finishDelivery(sqlite, delivery, 'failed', at, 'not_deliverable')
        if (delivery.cycle_attempts >= 4)
          return finishDelivery(sqlite, delivery, 'unknown', at, 'attempts_exhausted')
        const leaseId = randomUUID()
        const leaseUntil = now + 30_000
        sqlite
          .prepare(
            `UPDATE approval_deliveries SET state = 'delivering', cycle_attempts = cycle_attempts + 1, lease_id = ?, lease_until = ?, maybe_applied = 1, updated_at = ? WHERE id = ?`,
          )
          .run(leaseId, leaseUntil, at, delivery.id)
        sqlite
          .prepare(
            'INSERT INTO approval_delivery_leases (lease_id, delivery_id, cycle, issued_at) VALUES (?, ?, ?, ?)',
          )
          .run(leaseId, delivery.id, delivery.cycle, now)
        items.push({
          deliveryId: delivery.id,
          leaseId,
          leaseUntil: new Date(leaseUntil).toISOString(),
          sessionKey: row.session_key,
          requestId: row.request_id!,
          choice: delivery.choice,
          reason: null,
        })
        refreshApproval(sqlite, row.id, at)
        return approvalDraft(sqlite, row.id, { now })
      })
    })
    return items
  }
  async acknowledgeBridge(producerId: string, deliveryId: string, value: unknown): Promise<void> {
    const ack = BridgeDecisionAckRequestSchema.parse(value)
    await this.change((sqlite, at) => {
      const value = sqlite
        .prepare(
          `SELECT d.* FROM approval_deliveries d JOIN approval_delivery_leases l ON l.delivery_id = d.id WHERE d.id = ? AND d.producer_id = ? AND l.lease_id = ?`,
        )
        .get(deliveryId, producerId, ack.leaseId)
      if (!value) throw new HttpError(404, 'not_found', 'Unknown delivery')
      sqlite.prepare('UPDATE producers SET last_seen_at = ? WHERE id = ?').run(at, producerId)
      const delivery = DeliveryRowSchema.parse(value)
      if (ack.outcome === 'applied') return finishDelivery(sqlite, delivery, 'applied', at)
      if (delivery.state !== 'delivering' || delivery.lease_id !== ack.leaseId) return []
      if (ack.outcome === 'not_pending') {
        const { count } = z
          .object({ count: z.int() })
          .parse(
            sqlite
              .prepare(
                'SELECT count(*) AS count FROM approval_delivery_leases WHERE delivery_id = ? AND cycle = ?',
              )
              .get(delivery.id, delivery.cycle),
          )
        return delivery.cycle_attempts === 1 && count === 1
          ? firstBridgeNotPending(sqlite, delivery, at)
          : finishDelivery(sqlite, delivery, 'unknown', at)
      }
      // Only codes chosen by Score are persisted; producer error text never enters the ledger.
      if (delivery.cycle_attempts >= 3)
        return finishDelivery(sqlite, delivery, 'unknown', at, 'bridge_failed')
      sqlite
        .prepare(
          `UPDATE approval_deliveries SET state = 'intent', error = 'bridge_failed', updated_at = ? WHERE id = ?`,
        )
        .run(at, delivery.id)
      refreshApproval(sqlite, delivery.approval_id, at)
      return approvalDraft(sqlite, delivery.approval_id, { now: Date.parse(at) })
    })
    this.notifier.wake(producerId)
  }
  async sweep(): Promise<void> {
    const now = this.clock()
    const candidates = z
      .array(DeliveryRowSchema)
      .parse(
        this.deps.db.sqlite
          .prepare("SELECT * FROM approval_deliveries WHERE state IN ('intent','delivering')")
          .all(),
      )
    if (
      !candidates.some((delivery) => {
        const row = readApprovalRow(this.deps.db.sqlite, delivery.approval_id)!
        if (delivery.state === 'intent') return !deliverable(row, delivery, now)
        if (delivery.route !== 'bridge' || (delivery.lease_until ?? Infinity) > now) return false
        const value = this.deps.db.sqlite
          .prepare('SELECT last_seen_at FROM producers WHERE id = ?')
          .get(delivery.producer_id ?? '')
        const seen = value
          ? Date.parse(z.object({ last_seen_at: z.iso.datetime() }).parse(value).last_seen_at)
          : -Infinity
        return seen < now - 120_000 || !deliverable(row, delivery, now)
      })
    )
      return
    await this.change((sqlite, at) => {
      const now = Date.parse(at)
      const rows = z
        .array(DeliveryRowSchema)
        .parse(
          sqlite
            .prepare(`SELECT * FROM approval_deliveries WHERE state IN ('intent','delivering')`)
            .all(),
        )
      return rows.flatMap((delivery) => {
        const row = readApprovalRow(sqlite, delivery.approval_id)!
        if (delivery.state === 'intent' && !deliverable(row, delivery, now))
          return finishDelivery(sqlite, delivery, 'failed', at, 'not_deliverable')
        if (
          delivery.route !== 'bridge' ||
          delivery.state !== 'delivering' ||
          (delivery.lease_until ?? Infinity) > now
        )
          return []
        const value = sqlite
          .prepare('SELECT last_seen_at FROM producers WHERE id = ?')
          .get(delivery.producer_id ?? '')
        const seen = value
          ? Date.parse(z.object({ last_seen_at: z.iso.datetime() }).parse(value).last_seen_at)
          : -Infinity
        return seen < now - 120_000 || !deliverable(row, delivery, now)
          ? finishDelivery(sqlite, delivery, 'unknown', at, 'lease_expired')
          : []
      })
    })
  }
  async stop(): Promise<void> {
    this.stopped = true
    clearInterval(this.timer)
    this.notifier.close()
    await this.flight
  }
}
