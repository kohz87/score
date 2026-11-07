import path from 'node:path'
import { z } from 'zod'
import type { KnowledgeDocumentSummary, KnowledgeDocumentType } from '@score/contract'
import { KnowledgeTextStatusSchema } from '@score/contract'
import { HttpError } from '../errors.ts'
import { authorFromColumn, parseVaultPath } from './note.ts'

export type TextStatus = z.infer<typeof KnowledgeTextStatusSchema>

export const DocRowSchema = z.object({
  id: z.number(),
  path: z.string(),
  type: z.enum(['pdf', 'docx', 'csv', 'json', 'html', 'image', 'zip']),
  mtime_ms: z.number(),
  size: z.number(),
  hash: z.string(),
  versioned: z.number(),
  text_status: KnowledgeTextStatusSchema,
  entries_json: z.string().nullable(),
  last_author: z.string().nullable(),
})
export type DocRow = z.infer<typeof DocRowSchema>
export const EntriesSchema = z.array(z.object({ path: z.string(), size: z.number() }))
export const MAX_EVENTS = 200

export type OnConflict = 'ask' | 'keep' | 'replace'

export interface PreparedDocument {
  kind: 'document'
  path: string
  type: KnowledgeDocumentType
  bytes: Buffer
  text: string
  status: TextStatus
  entries: Array<{ path: string; size: number }> | null
}
interface PreparedNote {
  kind: 'note'
  path: string
  bytes: Buffer
}
export type Prepared = PreparedDocument | PreparedNote
export type IngestOutcome = 'unchanged' | 'upserted' | 'removed' | 'unreadable'
/** An unzipped file waiting to be placed: its bytes stay in the scratch folder (`facts` null = a note). */
export interface Unpacked {
  path: string
  file: string
  facts: Omit<PreparedDocument, 'bytes'> | null
}
export const withoutBytes = (document: PreparedDocument): Omit<PreparedDocument, 'bytes'> => ({
  kind: 'document',
  path: document.path,
  type: document.type,
  text: document.text,
  status: document.status,
  entries: document.entries,
})

export const toSummary = (row: DocRow): KnowledgeDocumentSummary => ({
  path: row.path,
  type: row.type,
  size: row.size,
  mtime: new Date(row.mtime_ms).toISOString(),
  lastAuthor: authorFromColumn(row.last_author),
  versioned: row.versioned === 1,
  textStatus: row.text_status,
})

/** Free name for `keep both`: `report.pdf` -> `report (2).pdf`. */
export function suffixed(rel: string, n: number): string {
  const dir = path.posix.dirname(rel)
  const base = path.posix.basename(rel)
  const dot = base.lastIndexOf('.')
  const name = dot > 0 ? `${base.slice(0, dot)} (${n})${base.slice(dot)}` : `${base} (${n})`
  return dir === '.' ? name : `${dir}/${name}`
}

export function cleanSegments(input: string): string[] {
  const segments = parseVaultPath(input)
  if (segments.some((segment) => segment.startsWith('.')))
    throw new HttpError(400, 'bad_path', 'Hidden files and folders are not part of Knowledge.')
  return segments
}
