import type { BridgeEvent } from '@score/contract'
import type { DatabaseSync } from 'node:sqlite'
import { hermesDeletedSessions } from '../../domain/session-retirement.ts'
import type { DomainEventDraft } from '../../hub/ingest.ts'
import { redact } from '../../redact.ts'
import type { Producer } from './registry.ts'
import type { BridgeLog } from './translate-log.ts'
import {
  sessionIds,
  type CompactionPayload,
  type DeletePayload,
  type GapPayload,
} from './translate-schemas.ts'

export interface DeletedSessionsContext {
  sqlite: DatabaseSync
  producer: Producer
  deleted: DeletePayload
  now: string
  log: BridgeLog
}

export function applyDeletedSessionsEvent({
  sqlite,
  producer,
  deleted,
  now,
  log,
}: DeletedSessionsContext): DomainEventDraft[] {
  const ids = sessionIds([...(deleted.deleted_ids ?? []), deleted.session_id])
  return [
    ...hermesDeletedSessions(sqlite, producer.profile, ids, deleted.reason ?? '', now),
    log(
      'system',
      `Hermes deleted ${ids.length} session${ids.length === 1 ? '' : 's'} (${deleted.reason ?? 'unknown'})`,
    ),
  ]
}

export interface CompactionContext {
  compacted: CompactionPayload | undefined
  log: BridgeLog
}

export function applyCompactionEvent({ compacted, log }: CompactionContext): DomainEventDraft[] {
  const removed = compacted?.messages_removed
  const tokens =
    compacted?.before_tokens != null && compacted.after_tokens != null
      ? `, ${compacted.before_tokens} → ${compacted.after_tokens} tokens`
      : ''
  return [
    log(
      'system',
      `Hermes compacted the conversation${removed != null ? ` (${removed} messages summarised${tokens})` : ''}`,
    ),
  ]
}

export interface GapContext {
  sqlite: DatabaseSync
  producer: Producer
  source: string
  event: BridgeEvent
  gap: GapPayload
  now: string
}

export function applyGapEvent({
  sqlite,
  producer,
  source,
  event,
  gap,
  now,
}: GapContext): DomainEventDraft[] {
  const reason = redact(
    `Bridge dropped ${gap.dropped} events (counters ${gap.from_counter}–${gap.to_counter})`,
  )
  sqlite
    .prepare('INSERT INTO gaps (source, run_id, from_ts, to_ts, reason) VALUES (?, NULL, ?, ?, ?)')
    .run(source, event.at, event.at, reason)
  sqlite
    .prepare(
      `INSERT INTO ingest_checkpoints (source, scope, cursor, incarnation, updated_at)
          VALUES (?, ?, ?, ?, ?) ON CONFLICT (source, scope) DO UPDATE SET cursor = MAX(CAST(cursor AS INTEGER), CAST(excluded.cursor AS INTEGER)), updated_at = excluded.updated_at`,
    )
    .run(source, `gap:${gap.from_counter}`, String(gap.to_counter), producer.incarnation, now)
  return [
    {
      type: 'gap.recorded',
      data: { source, runId: null, from: event.at, to: event.at, reason },
    },
  ]
}

export interface TextEventContext {
  event: BridgeEvent
  message: boolean
  text: { text?: string | undefined; message?: string | undefined }
  log: BridgeLog
}

export function applyTextEvent({
  event,
  message,
  text,
  log,
}: TextEventContext): DomainEventDraft[] {
  return [
    log(
      message ? 'message' : 'system',
      `${event.hook}${text.text || text.message ? `: ${text.text ?? text.message}` : ''}`,
    ),
  ]
}
