import type { KnowledgeDocumentType } from '@score/contract'
import { DOCX_TYPE, isPlainText, sniffImage, sniffMedia } from '../media/sniff.ts'

// What Knowledge accepts besides Markdown notes (PLAN 6.6). The type comes from the extension (allow-list) AND the
// bytes (magic numbers / plain-text check): a file whose bytes disagree with its extension is refused.

export const MAX_FILE_BYTES = 25 * 1024 * 1024
/** Documents up to this size are committed to the vault's git; larger ones are only stored. */
export const MAX_VERSIONED_BYTES = 10 * 1024 * 1024
/** Extracted text kept per document. */
export const MAX_TEXT_BYTES = 2 * 1024 * 1024

const DOCUMENT_EXTENSIONS: Record<string, KnowledgeDocumentType> = {
  pdf: 'pdf',
  docx: 'docx',
  csv: 'csv',
  json: 'json',
  html: 'html',
  htm: 'html',
  png: 'image',
  jpg: 'image',
  jpeg: 'image',
  gif: 'image',
  webp: 'image',
  zip: 'zip',
}
const NOTE_EXTENSIONS = new Set(['md', 'markdown', 'txt'])

export type FileClass =
  { kind: 'note'; name: string } | { kind: 'document'; type: KnowledgeDocumentType; name: string }

const extensionOf = (name: string): string =>
  /\.([A-Za-z0-9]{1,8})$/.exec(name)?.[1]?.toLowerCase() ?? ''

/** Decides what a file name stands for; `.txt`, `.markdown` and `.MD` (any case) become a `.md` note. Null when the type is not accepted. */
export function classifyName(name: string): FileClass | null {
  const extension = extensionOf(name)
  if (NOTE_EXTENSIONS.has(extension)) {
    const stem = name.slice(0, name.length - extension.length - 1)
    if (stem === '') return null
    return { kind: 'note', name: `${stem}.md` }
  }
  const type = DOCUMENT_EXTENSIONS[extension]
  if (!type || name.length === extension.length + 1) return null
  return { kind: 'document', type, name }
}

/** Whether the bytes really are what the type says. */
export function bytesMatch(type: KnowledgeDocumentType, bytes: Uint8Array): boolean {
  switch (type) {
    case 'pdf':
      return Buffer.from(bytes.subarray(0, 5)).toString('latin1') === '%PDF-'
    case 'docx':
      return sniffMedia(bytes) === DOCX_TYPE
    case 'image':
      return sniffImage(bytes) !== null
    case 'zip':
      // Local file header, or the end-of-central-directory record of an empty archive.
      return (
        bytes.length >= 4 &&
        bytes[0] === 0x50 &&
        bytes[1] === 0x4b &&
        ((bytes[2] === 0x03 && bytes[3] === 0x04) || (bytes[2] === 0x05 && bytes[3] === 0x06))
      )
    case 'csv':
    case 'json':
    case 'html':
      return isPlainText(bytes)
  }
}

export function isDocumentPath(path: string): boolean {
  return DOCUMENT_EXTENSIONS[extensionOf(path)] !== undefined
}
export function documentTypeOfPath(path: string): KnowledgeDocumentType | null {
  return DOCUMENT_EXTENSIONS[extensionOf(path)] ?? null
}

/** Text kinds whose bytes are stored as extracted text. */
export const PLAIN_TEXT_TYPES: readonly KnowledgeDocumentType[] = ['csv', 'json']
/** Types that go through the extraction worker. */
export const WORKER_TEXT_TYPES: readonly KnowledgeDocumentType[] = ['pdf', 'docx', 'html']
