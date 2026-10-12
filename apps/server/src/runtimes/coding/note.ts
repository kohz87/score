import { createHash } from 'node:crypto'
import { redact, redactBounded } from '../../redact.ts'
import type { CodingEvent, LineParser, ToolDetail } from './types.ts'

/**
 * A free-text note as it may be stored or shown (7.7a re-review 2026-10-12 #3). A colon before a credential label makes
 * the redactor read the words in front of it as the key, so the label is never seen; colons are neutralised first.
 */
export function redactNote(text: string, bytes: number): string {
  return redactBounded(text.replace(/:\s+/g, ' - '), bytes)
}

/** Most call ids / step ids a parser or translator remembers at once (state kept per active run). */
export const MAX_REMEMBERED_IDS = 1024
/** Most commentary text a run keeps in memory for its failure note; the database copy is bounded separately. */
export const MAX_RETAINED_TEXT_BYTES = 32 * 1024

/** Adds to a set that forgets its oldest entries past `MAX_REMEMBERED_IDS`. */
export function rememberId<T>(set: Set<T>, id: T): void {
  set.add(id)
  if (set.size > MAX_REMEMBERED_IDS) set.delete(set.values().next().value as T)
}

/** Text kept from the start of a stream, up to a byte limit; the rest is dropped, not buffered. */
export class CappedText {
  private text = ''
  private bytes = 0
  constructor(private readonly limit = MAX_RETAINED_TEXT_BYTES) {}
  push(chunk: string): void {
    if (this.bytes >= this.limit) return
    const room = this.limit - this.bytes
    const kept =
      Buffer.byteLength(chunk) <= room
        ? chunk
        : Buffer.from(chunk).subarray(0, room).toString('utf8')
    this.text += kept
    this.bytes += Buffer.byteLength(kept)
  }
  get value(): string {
    return this.text
  }
  get size(): number {
    return this.bytes
  }
}

/**
 * A process's stderr as it may be kept (7.7a re-review 2026-10-12 #5). Redaction needs the label in front of a value, so
 * the text is kept from its start (never a tail cut through a value) up to a raw limit and redacted as a whole whenever
 * it is read; past the limit the rest is dropped.
 */
export class BoundedDiagnostics {
  private raw = ''
  private overflowed = false
  constructor(
    private readonly rawLimit = 64 * 1024,
    private readonly keepBytes = 8 * 1024,
  ) {}

  push(text: string): void {
    if (this.overflowed) return
    const room = this.rawLimit - this.raw.length
    if (text.length > room) {
      this.raw += text.slice(0, Math.max(0, room))
      this.overflowed = true
    } else this.raw += text
  }

  /** On the raw start, for protocol messages Score's own launcher prints. */
  startsWith(prefix: string): boolean {
    return this.raw.startsWith(prefix)
  }

  /** Redacted and bounded; safe to store or show. */
  text(): string {
    const safe = redactNote(
      this.overflowed ? closeOpenCredential(this.raw) : this.raw,
      this.keepBytes,
    )
    return this.overflowed ? `${safe} […]` : safe
  }
}

/**
 * The raw cap cut the text somewhere (FW #6). A credential value the cut left open would be read by the redactor as just
 * its first word, or its prefix would no longer be recognisable. So the partial last word is discarded and any quote the
 * cut left open is closed: the redactor then sees the whole value and masks it to the end.
 */
export function closeOpenCredential(raw: string): string {
  let text = raw.replace(/[^\s"']*$/, '')
  for (const quote of ['"', "'"] as const) if (text.split(quote).length % 2 === 0) text += quote
  return text
}

// ---- bounds on what a parser and the translator keep (7.7a re-review 2026-10-12 #18) -------------------------------

/** Longest id kept as is; a longer one is replaced by a short stable form (the same id always maps to the same one). */
export const MAX_ID_BYTES = 256
/** Longest single field of a tool's detail kept in memory (the frames bound their own output further). */
export const MAX_DETAIL_FIELD_BYTES = 16 * 1024
/** Longest candidate reply a run retains; a longer one is not an authoritative reply. */
export const MAX_REPLY_BYTES = 256 * 1024
const MAX_TOOL_NAME_BYTES = 200
const MAX_PREVIEW_BYTES = 8 * 1024
const MAX_ERROR_BYTES = 8 * 1024

/** Text cut to a byte limit on a character boundary. */
export function cutBytes(text: string, limit: number): string {
  if (Buffer.byteLength(text) <= limit) return text
  let end = Math.min(text.length, limit)
  let cut = text.slice(0, end)
  while (Buffer.byteLength(cut) > limit) cut = text.slice(0, --end)
  return cut
}

/** An id as it may be remembered: short ids unchanged, long ones a prefix plus a digest of the whole. */
export function boundId(id: string): string {
  if (Buffer.byteLength(id) <= MAX_ID_BYTES) return id
  return `${cutBytes(redact(id), 128)}~${createHash('sha256').update(id).digest('hex').slice(0, 32)}`
}

/** A CLI-supplied field: redacted as a whole first, then cut (a cut can remove the closing quote or the label). */
function safeCut(text: string, limit: number): string {
  return cutBytes(redact(text), limit)
}

function boundDetail(detail: ToolDetail): ToolDetail {
  const cut = (text: string) => safeCut(text, MAX_DETAIL_FIELD_BYTES)
  switch (detail.type) {
    case 'command':
      return {
        ...detail,
        command: cut(detail.command),
        ...(detail.cwd ? { cwd: cut(detail.cwd) } : {}),
      }
    case 'write':
      return { ...detail, path: cut(detail.path), content: cut(detail.content) }
    case 'replace':
      return {
        ...detail,
        path: cut(detail.path),
        oldString: cut(detail.oldString),
        newString: cut(detail.newString),
      }
    case 'file':
      return { ...detail, path: cut(detail.path) }
    case 'browser':
      return { ...detail, url: detail.url === null ? null : cut(detail.url) }
  }
}

/** One event with every free-form value bounded; redaction of CLI metadata happens where it is stored. */
export function boundEvent(event: CodingEvent): CodingEvent {
  switch (event.kind) {
    case 'tool_start':
      return {
        ...event,
        callId: boundId(event.callId),
        tool: redactNote(event.tool, MAX_TOOL_NAME_BYTES),
        preview: safeCut(event.preview, MAX_PREVIEW_BYTES),
        ...(event.detail ? { detail: boundDetail(event.detail) } : {}),
      }
    case 'tool_end':
      return {
        ...event,
        callId: boundId(event.callId),
        preview: safeCut(event.preview, MAX_PREVIEW_BYTES),
      }
    case 'result': {
      const verdict =
        event.verdict?.eligible && Buffer.byteLength(event.verdict.reply ?? '') > MAX_REPLY_BYTES
          ? { eligible: false, reply: null, reason: 'The reply is larger than Score keeps' }
          : event.verdict
      return {
        ...event,
        ...(event.text === undefined ? {} : { text: cutBytes(event.text, MAX_REPLY_BYTES) }),
        ...(event.error === undefined ? {} : { error: safeCut(event.error, MAX_ERROR_BYTES) }),
        ...(verdict ? { verdict } : {}),
      }
    }
    default:
      return event
  }
}

/** Bytes a retained event holds (ids, details, replies). */
export function eventBytes(event: CodingEvent | null): number {
  if (!event) return 0
  switch (event.kind) {
    case 'tool_start':
      return (
        Buffer.byteLength(event.callId) + Buffer.byteLength(event.tool) + detailBytes(event.detail)
      )
    case 'result':
      return (
        Buffer.byteLength(event.text ?? '') +
        Buffer.byteLength(event.error ?? '') +
        Buffer.byteLength(event.verdict?.reply ?? '')
      )
    default:
      return 0
  }
}

export function detailBytes(detail: ToolDetail | undefined): number {
  if (!detail) return 0
  const size = (text: string | undefined | null) => Buffer.byteLength(text ?? '')
  switch (detail.type) {
    case 'command':
      return size(detail.command) + size(detail.cwd)
    case 'write':
      return size(detail.path) + size(detail.content)
    case 'replace':
      return size(detail.path) + size(detail.oldString) + size(detail.newString)
    case 'file':
      return size(detail.path)
    case 'browser':
      return size(detail.url)
  }
}

/**
 * Wraps a driver's parser: every event it yields is bounded, and `retainedBytes()` reports what the parser and the
 * result it last produced hold (its own state, when it declares one, plus the candidate reply the caller keeps).
 */
export function withBounds(
  inner: LineParser & { ownBytes?(): number },
): LineParser & { retainedBytes(): number } {
  let result: CodingEvent | null = null
  return {
    stats: inner.stats,
    ...(inner.lossReason ? { lossReason: () => inner.lossReason!() } : {}),
    parse(line) {
      const events = inner.parse(line).map(boundEvent)
      for (const event of events) if (event.kind === 'result') result = event
      return events
    },
    retainedBytes: () => (inner.ownBytes?.() ?? 0) + eventBytes(result),
  }
}
