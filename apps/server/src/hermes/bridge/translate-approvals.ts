import type { BridgeEvent } from '@score/contract'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { applyApprovalSignal, GateSignalSchema } from '../../domain/approvals.ts'
import type { DomainEventDraft } from '../../hub/ingest.ts'
import type { Producer } from './registry.ts'
import type { BridgeLog } from './translate-log.ts'
import type { ApprovalPayload } from './translate-schemas.ts'

export interface ApprovalEventContext {
  sqlite: DatabaseSync
  now: string
  producer: Producer
  event: BridgeEvent
  disabled: readonly string[]
  log: BridgeLog
  approval: ApprovalPayload
  signal: z.infer<typeof GateSignalSchema> | undefined
}

export function applyApprovalEvent({
  sqlite,
  now,
  producer,
  event,
  disabled,
  log,
  approval,
  signal,
}: ApprovalEventContext): DomainEventDraft[] {
  const inserted = sqlite
    .prepare(
      `INSERT INTO approval_signals
          (producer_id, profile, hook, session_key, request_id, payload, at, producer_incarnation, counter, gate_id, linked_gate_id, transport_request_id)
          VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      producer.id,
      producer.profile,
      event.hook,
      event.sessionKey,
      approval.requestId ?? null,
      JSON.stringify({ ...event.payload, ...signal }),
      event.at,
      producer.incarnation,
      event.counter,
      approval.gateId ?? null,
      approval.linkedGateId ?? null,
      approval.transportRequestId ?? null,
    )
  return [
    ...applyApprovalSignal(sqlite, Number(inserted.lastInsertRowid), now, { disabled }),
    log('approval', event.hook),
  ]
}
