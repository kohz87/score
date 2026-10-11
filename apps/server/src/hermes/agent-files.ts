import { createHash } from 'node:crypto'
import { z } from 'zod'
import { HttpError } from '../errors.ts'

/** The only profile files Score ever writes (ARCHITECTURE D2.6). */
export const AgentFileNameSchema = z.enum(['SOUL.md', 'AGENTS.md'])
export type AgentFileName = z.infer<typeof AgentFileNameSchema>
export const MAX_AGENT_FILE_BYTES = 256 * 1024
export const EtagSchema = z.string().regex(/^[0-9a-f]{64}$/)

export interface AgentFile {
  content: string
  etag: string
}
/** Thrown when the submitted etag no longer matches; carries the file as it is now. */
export class AgentFileConflictError extends Error {
  constructor(readonly current: AgentFile) {
    super('The file changed since it was loaded')
    this.name = 'AgentFileConflictError'
  }
}

export function etagOf(bytes: Buffer | string): string {
  return createHash('sha256').update(bytes).digest('hex')
}
/** UTF-8 text without NUL, within the size limit. */
export function assertFileContent(content: string): void {
  if (content.includes('\0'))
    throw new HttpError(400, 'validation_error', 'The file can’t contain null bytes.')
  if (Buffer.byteLength(content, 'utf8') > MAX_AGENT_FILE_BYTES)
    throw new HttpError(413, 'payload_too_large', 'The file is larger than 256 KB.')
  // Lone surrogates would not survive a UTF-8 round trip.
  if (!content.isWellFormed())
    throw new HttpError(400, 'validation_error', 'The file must be UTF-8 text.')
}
export function decodeFileBytes(bytes: Buffer): string {
  if (bytes.length > MAX_AGENT_FILE_BYTES)
    throw new HttpError(413, 'payload_too_large', 'The file is larger than 256 KB.')
  try {
    const text = new TextDecoder('utf-8', { fatal: true }).decode(bytes)
    if (text.includes('\0')) throw new Error('NUL')
    return text
  } catch {
    throw new HttpError(
      422,
      'unreadable_file',
      'This file isn’t UTF-8 text, so Score can’t open it.',
    )
  }
}
// Presentation excerpt: the first prose paragraph, headings skipped, bounded to 280 characters.
export function excerpt(text: string): string {
  const paragraph =
    text
      .split(/\r?\n\s*\r?\n/)
      .map((part) => part.replace(/^#{1,6}\s+[^\n]*(?:\r?\n|$)/gm, '').trim())
      .find(Boolean) ?? ''
  let result = ''
  for (const char of paragraph.replace(/\s+/g, ' ')) {
    if (result.length + char.length > 280) break
    result += char
  }
  return result
}
