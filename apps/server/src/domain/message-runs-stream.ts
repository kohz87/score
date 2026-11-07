import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import type { DatabaseSync } from 'node:sqlite'
import { ORCH_LIMITS } from '@score/contract'
import type { DomainEventDraft } from '../hub/ingest.ts'
import { redact } from '../redact.ts'
import { MessageRunSchema, type MessageRun } from './message-runs-turns.ts'
import { updateMessage } from './rooms.ts'
import { markFirstOutput } from './run-speed.ts'

// Redaction matches whole patterns, but a run streams text in arbitrary chunks: a token, or a label and its value
// ("Authorization: Bearer" + "eyJ…", "api_key:" + value, a private key over many chunks), can arrive split. Text a
// later chunk could still turn into a secret is held back (not stored in the message, not emitted) until it settles
// or the run completes. The held text is sealed with a per-process key so raw fragments never sit on disk; after a
// restart it can't be opened and is dropped (at worst the last words of an interrupted reply).
const MAX_HELD = 8192
const SECRET_CONTEXT =
  /(?:[=:]|\b(?:authorization|bearer|basic|key|token|secret|password|passwd))["']?\s*$/i
const OPEN_QUOTE = /[=:]\s*(["'])(?:(?!\1)[^\n])*$/
const lineStart = (text: string, index: number) => text.lastIndexOf('\n', index - 1) + 1

/** How much of `text` no later chunk can change: the rest stays held. */
function settledLength(text: string): number {
  let cut = 0
  for (let index = text.length - 1; index >= 0; index--)
    if (/\s/.test(text[index]!)) {
      cut = index + 1
      break
    }
  // A label that a value may still follow holds its whole line back.
  const from = Math.max(0, cut - 200)
  const context = SECRET_CONTEXT.exec(text.slice(from, cut))
  if (context) cut = Math.min(cut, lineStart(text, from + context.index))
  if (OPEN_QUOTE.test(text.slice(lineStart(text, cut), cut))) cut = lineStart(text, cut)
  // An unterminated PEM block holds everything from its start.
  const begin = text.lastIndexOf('-----BEGIN')
  if (begin !== -1 && !/-----END [A-Z0-9 ]+-----/.test(text.slice(begin)))
    cut = Math.min(cut, lineStart(text, begin))
  return cut
}
/** Held text past the limit: true when it can't be kept back any longer. */
const overflows = (text: string, cut: number) => text.length - cut > MAX_HELD

const SEAL_KEY = randomBytes(32)
function seal(text: string): string {
  if (!text) return ''
  const iv = randomBytes(12)
  const cipher = createCipheriv('aes-256-gcm', SEAL_KEY, iv)
  const body = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()])
  return Buffer.concat([iv, cipher.getAuthTag(), body]).toString('base64')
}
// null: sealed by an earlier process, so it can't be opened.
function unseal(value: string): string | null {
  if (!value) return ''
  try {
    const raw = Buffer.from(value, 'base64')
    const decipher = createDecipheriv('aes-256-gcm', SEAL_KEY, raw.subarray(0, 12))
    decipher.setAuthTag(raw.subarray(12, 28))
    return Buffer.concat([decipher.update(raw.subarray(28)), decipher.final()]).toString('utf8')
  } catch {
    return null
  }
}
// "!" marks a reply whose held text was lost to a restart: later chunks then leave an interior gap that only the
// run's final output can repair. "!" is not base64, so it can't collide with sealed text.
const LOST = '!'
export function readPending(value: string): { text: string; lost: boolean } {
  const lost = value.startsWith(LOST)
  const text = unseal(lost ? value.slice(1) : value)
  return { text: text ?? '', lost: lost || text === null }
}
const writePending = (text: string, lost: boolean) => (lost ? LOST : '') + seal(text)

const REPLY_MARK = '\n[reply truncated]'

/**
 * An orchestration attempt's reply is bounded at the ingestion edge (PLAN 7.5): streamed text past the result limit is
 * dropped and flagged once, so a runaway agent cannot grow the room, the events or the run's storage reserve.
 */
export function clampReply(sqlite: DatabaseSync, mapping: MessageRun, piece: string): string {
  if (!mapping.orchestration_attempt_id || !piece) return piece
  const row = sqlite.prepare('SELECT parts FROM messages WHERE id = ?').get(mapping.message_id) as
    { parts: string } | undefined
  const current = row
    ? (JSON.parse(row.parts) as { kind: string; text?: string }[])
        .filter((part) => part.kind === 'text')
        .map((part) => part.text ?? '')
        .join('')
    : ''
  if (current.endsWith(REPLY_MARK)) return ''
  const room = ORCH_LIMITS.resultBytes - Buffer.byteLength(current)
  if (room <= 0) return REPLY_MARK
  if (Buffer.byteLength(piece) <= room) return piece
  let kept = ''
  for (const char of piece) {
    if (Buffer.byteLength(kept + char) > room) break
    kept += char
  }
  return kept + REPLY_MARK
}

export function appendRunMessage(
  sqlite: DatabaseSync,
  runId: string,
  append: string,
  now: string,
): DomainEventDraft[] {
  // The first reply text is the run's first output (time to first token), whether or not a message shows it.
  if (append.trim().length > 0) markFirstOutput(sqlite, runId, now)
  const value = sqlite.prepare('SELECT * FROM message_runs WHERE run_id = ?').get(runId)
  if (!value) return []
  const mapping = MessageRunSchema.parse(value)
  const held = readPending(mapping.pending)
  // The redaction context (a "Bearer " label, a PEM start) went with the lost held text, so a continuation can't be
  // redacted safely: show nothing more until the run's final output arrives and is redacted whole.
  if (held.lost) {
    sqlite
      .prepare('UPDATE message_runs SET pending = ? WHERE message_id = ?')
      .run(writePending('', true), mapping.message_id)
    return []
  }
  const text = held.text + append
  const cut = settledLength(text)
  // Too much unsettled text (an unterminated key block, a label whose value never ends): publishing it would lose the
  // context that marks it secret, and later chunks would follow unredacted. Fail closed: publish the settled part,
  // then nothing more until the run's final output arrives and is redacted whole (the "lost" path).
  if (overflows(text, cut)) {
    sqlite
      .prepare('UPDATE message_runs SET pending = ? WHERE message_id = ?')
      .run(writePending('', true), mapping.message_id)
    return cut > 0
      ? updateMessage(
          sqlite,
          mapping.room_id,
          mapping.message_id,
          clampReply(sqlite, mapping, redact(text.slice(0, cut))),
          now,
        )
      : []
  }
  sqlite
    .prepare('UPDATE message_runs SET pending = ? WHERE message_id = ?')
    .run(writePending(text.slice(cut), held.lost), mapping.message_id)
  const piece = cut > 0 ? clampReply(sqlite, mapping, redact(text.slice(0, cut))) : ''
  return piece ? updateMessage(sqlite, mapping.room_id, mapping.message_id, piece, now) : []
}

export function flushHeld(
  sqlite: DatabaseSync,
  mapping: MessageRun,
  now: string,
): DomainEventDraft[] {
  if (!mapping.pending) return []
  const held = readPending(mapping.pending).text
  sqlite
    .prepare("UPDATE message_runs SET pending = '' WHERE message_id = ?")
    .run(mapping.message_id)
  const piece = held ? clampReply(sqlite, mapping, redact(held)) : ''
  return piece ? updateMessage(sqlite, mapping.room_id, mapping.message_id, piece, now) : []
}

/**
 * A run showed life (reasoning, a tool call, an approval, text): restart its reply's stall clock. Text is announced by
 * `message.delta` already, so only the other moves get a `message.progressed` event.
 */
export function noteRunProgress(
  sqlite: DatabaseSync,
  runId: string,
  at: string,
  { announce }: { announce: boolean },
): DomainEventDraft[] {
  const row = sqlite
    .prepare(
      `SELECT m.id, m.room_id FROM message_runs r JOIN messages m ON m.id = r.message_id
       WHERE r.run_id = ? AND m.streaming = 1`,
    )
    .get(runId) as { id: string; room_id: string } | undefined
  if (!row) return []
  // Only forwards: replayed or out-of-order events never move the clock back. At most one write per 5 s: the browser
  // follows live progress from the stream; the stored value only matters when a page loads.
  const throttle = new Date(Date.parse(at) - 5_000).toISOString()
  const changed = sqlite
    .prepare(
      'UPDATE messages SET progress_at = ? WHERE id = ? AND (progress_at IS NULL OR progress_at < ?)',
    )
    .run(at, row.id, throttle).changes
  return announce && changed
    ? [{ type: 'message.progressed', data: { roomId: row.room_id, messageId: row.id, at } }]
    : []
}
