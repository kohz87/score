export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const
export const DOCX_TYPE = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
export const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet'
export const TEXT_TYPES = [
  'text/plain',
  'text/markdown',
  'text/csv',
  'application/json',
  'text/html',
] as const
export const MEDIA_TYPES = [
  ...IMAGE_TYPES,
  'application/pdf',
  DOCX_TYPE,
  XLSX_TYPE,
  ...TEXT_TYPES,
] as const
export type MediaType = (typeof MEDIA_TYPES)[number]

export const isImageType = (type: string): boolean =>
  (IMAGE_TYPES as readonly string[]).includes(type)
export const isTextType = (type: string): boolean =>
  (TEXT_TYPES as readonly string[]).includes(type)

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

function startsWith(bytes: Uint8Array, at: number, signature: readonly number[]): boolean {
  return bytes.length >= at + signature.length && signature.every((b, i) => bytes[at + i] === b)
}
const ascii = (text: string) => [...text].map((char) => char.charCodeAt(0))

// The declared type is never trusted: the content type served later comes from these magic bytes only.
export function sniffImage(bytes: Uint8Array): (typeof IMAGE_TYPES)[number] | null {
  if (startsWith(bytes, 0, PNG)) return 'image/png'
  if (startsWith(bytes, 0, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (startsWith(bytes, 0, ascii('GIF87a')) || startsWith(bytes, 0, ascii('GIF89a')))
    return 'image/gif'
  if (startsWith(bytes, 0, ascii('RIFF')) && startsWith(bytes, 8, ascii('WEBP')))
    return 'image/webp'
  return null
}

// DOCX and XLSX are ZIP files: the central directory lists the entry names uncompressed, which is all that is
// needed to tell them apart (no inflating, no dependency). Everything is bounds-checked; hostile input gives null.
function zipEntryNames(bytes: Uint8Array): Set<string> | null {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
  if (!startsWith(bytes, 0, [0x50, 0x4b, 0x03, 0x04])) return null
  // The scan runs backwards and keeps going past candidates that do not describe a coherent archive: a signature
  // inside the archive comment is not the real record.
  for (let eocd = bytes.length - 22; eocd >= Math.max(0, bytes.length - 22 - 0xffff); eocd -= 1) {
    if (view.getUint32(eocd, true) !== 0x06054b50) continue
    const directoryEnd = view.getUint32(eocd + 16, true) + view.getUint32(eocd + 12, true)
    if (eocd + 22 + view.getUint16(eocd + 20, true) !== bytes.length || directoryEnd > eocd)
      continue
    const names = readDirectory(bytes, view, eocd)
    if (names && names.size > 0) return names
  }
  return null
}

function readDirectory(bytes: Uint8Array, view: DataView, eocd: number): Set<string> | null {
  const count = view.getUint16(eocd + 10, true)
  let at = view.getUint32(eocd + 16, true)
  const names = new Set<string>()
  for (let index = 0; index < count; index += 1) {
    if (at + 46 > bytes.length || view.getUint32(at, true) !== 0x02014b50) return null
    const nameLength = view.getUint16(at + 28, true)
    const extraLength = view.getUint16(at + 30, true)
    const commentLength = view.getUint16(at + 32, true)
    if (at + 46 + nameLength > bytes.length) return null
    names.add(Buffer.from(bytes.subarray(at + 46, at + 46 + nameLength)).toString('latin1'))
    at += 46 + nameLength + extraLength + commentLength
  }
  return names
}

const EXTENSION_TYPES: Record<string, (typeof TEXT_TYPES)[number]> = {
  txt: 'text/plain',
  text: 'text/plain',
  log: 'text/plain',
  md: 'text/markdown',
  markdown: 'text/markdown',
  csv: 'text/csv',
  json: 'application/json',
  html: 'text/html',
  htm: 'text/html',
}

// Valid UTF-8 with no NUL and no control characters other than tab, newline, form feed and carriage return.
export function isPlainText(bytes: Uint8Array): boolean {
  for (const byte of bytes) if (byte < 0x20 && ![9, 10, 12, 13].includes(byte)) return false
  try {
    new TextDecoder('utf-8', { fatal: true, ignoreBOM: true }).decode(bytes)
    return true
  } catch {
    return false
  }
}

/**
 * The stored type, from the bytes alone for images, PDF, DOCX and XLSX. Text has no magic number: it must be valid
 * plain text, and the file name's extension (or the declared type) then only picks among the text kinds.
 */
export function sniffMedia(
  bytes: Uint8Array,
  hint: { name?: string | undefined; declared?: string | undefined } = {},
): MediaType | null {
  const image = sniffImage(bytes)
  if (image) return image
  if (startsWith(bytes, 0, ascii('%PDF-'))) return 'application/pdf'
  // Only a full ZIP signature makes it an archive; "PK report" is just text.
  if (
    startsWith(bytes, 0, [0x50, 0x4b, 0x03, 0x04]) ||
    startsWith(bytes, 0, [0x50, 0x4b, 0x05, 0x06]) ||
    startsWith(bytes, 0, [0x50, 0x4b, 0x07, 0x08])
  ) {
    const names = zipEntryNames(bytes)
    if (!names) return null
    if (names.has('[Content_Types].xml') && names.has('word/document.xml')) return DOCX_TYPE
    if (names.has('[Content_Types].xml') && names.has('xl/workbook.xml')) return XLSX_TYPE
    return null
  }
  if (!isPlainText(bytes)) return null
  const extension = /\.([a-z0-9]{1,8})$/i.exec(hint.name ?? '')?.[1]?.toLowerCase()
  const declared = hint.declared?.split(';', 1)[0]?.trim().toLowerCase()
  let type: (typeof TEXT_TYPES)[number] | undefined =
    extension !== undefined ? EXTENSION_TYPES[extension] : undefined
  if (!type && declared && (TEXT_TYPES as readonly string[]).includes(declared))
    type = declared as (typeof TEXT_TYPES)[number]
  if (!type) return null
  // A ".json" that is not JSON is still a text file, not a lie to be rejected.
  if (type === 'application/json') {
    try {
      JSON.parse(Buffer.from(bytes).toString('utf8'))
    } catch {
      return 'text/plain'
    }
  }
  return type
}

// Declared types are only a consistency check: a lying label is rejected, an absent or generic one is ignored.
// Text labels vary by browser and OS, so only binary types are held to their label.
export function declaredMatches(declared: string | undefined, sniffed: MediaType): boolean {
  const raw = declared?.split(';', 1)[0]?.trim().toLowerCase()
  if (!raw || raw === 'application/octet-stream') return true
  const value = raw === 'image/jpg' ? 'image/jpeg' : raw
  if (isTextType(sniffed))
    return !(MEDIA_TYPES as readonly string[]).includes(value) || isTextType(value)
  return value === sniffed
}
