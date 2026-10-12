import { redactBounded } from '../../redact.ts'

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
