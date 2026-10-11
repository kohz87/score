import { KNOWLEDGE_IMAGE_MAX_BYTES, KNOWLEDGE_IMAGE_TYPES } from '@score/contract'
import { HttpError } from '../errors.ts'
import { sniffImage } from '../media/sniff.ts'
import { codeRanges } from './links.ts'

// Images embedded in a note (PLAN 6.8): `![alt](data:image/png;base64,...)`. The browser makes them; the server
// checks every one on each write, and keeps the base64 away from agents, search and snippets.

/** `![alt](data:<mime>;base64,<payload>)`; the destination has no spaces or parentheses. */
const IMAGE = /!\[([^\]\n]*)\]\((data:[^)\s]*)\)/g
const DATA_URI = /^data:([^;,]*)(;[^,]*)?,(.*)$/s
/** Any long base64 data URI left in text (outside image syntax); indexing drops these too. */
const LOOSE = /data:[A-Za-z0-9/+.-]+;base64,[A-Za-z0-9+/=]{64,}/g

export interface NoteImage {
  start: number
  end: number
  alt: string
  uri: string
}

/** The embedded-image syntax in `text`, outside code. */
export function findNoteImages(text: string): NoteImage[] {
  if (!text.includes('](data:')) return []
  const code = codeRanges(text)
  const found: NoteImage[] = []
  for (const match of text.matchAll(IMAGE)) {
    const start = match.index
    if (code.some(([from, to]) => start >= from && start < to)) continue
    found.push({ start, end: start + match[0].length, alt: match[1]!, uri: match[2]! })
  }
  return found
}

export const hasNoteImages = (text: string) => findNoteImages(text).length > 0

/** Decoded size of a base64 payload without decoding it. */
function base64Bytes(payload: string): number | null {
  if (payload.length % 4 !== 0 || !/^[A-Za-z0-9+/]*={0,2}$/.test(payload)) return null
  const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0
  return (payload.length / 4) * 3 - padding
}

/** Throws the HTTP error for the first embedded image that breaks a rule. */
export function validateNoteImages(text: string): void {
  for (const image of findNoteImages(text)) {
    const match = DATA_URI.exec(image.uri)
    const mime = match?.[1]?.toLowerCase() ?? ''
    if (!(KNOWLEDGE_IMAGE_TYPES as readonly string[]).includes(mime))
      throw new HttpError(
        415,
        'unsupported_type',
        mime === 'image/svg+xml'
          ? 'SVG images can’t be embedded in a note.'
          : 'Only PNG, JPEG, GIF and WebP images can be embedded in a note.',
      )
    const payload = match?.[3] ?? ''
    if (match?.[2]?.toLowerCase() !== ';base64')
      throw new HttpError(400, 'bad_request', 'An embedded image must be base64 encoded.')
    const size = base64Bytes(payload)
    if (size === null)
      throw new HttpError(400, 'bad_request', 'An embedded image isn’t valid base64.')
    if (size > KNOWLEDGE_IMAGE_MAX_BYTES)
      throw new HttpError(
        413,
        'payload_too_large',
        `An embedded image can be at most ${KNOWLEDGE_IMAGE_MAX_BYTES / 1024 / 1024} MB`,
      )
    // The first bytes are enough to check the magic number; decode a short prefix only.
    const head = Buffer.from(payload.slice(0, 64), 'base64')
    if (sniffImage(head) !== mime)
      throw new HttpError(
        415,
        'unsupported_type',
        'An embedded image doesn’t match its declared type.',
      )
  }
}

export function formatImageSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** What an agent sees instead of an image: `[image: <alt>, <size>]`. */
export function imagePlaceholder(image: NoteImage): string {
  const payload = DATA_URI.exec(image.uri)?.[3] ?? ''
  const alt = image.alt.replace(/[[\]\n]/g, ' ').trim() || 'image'
  return `[image: ${alt}, ${formatImageSize(base64Bytes(payload) ?? payload.length)}]`
}

/** The note with every embedded image replaced by its placeholder. */
export function withPlaceholders(text: string): string {
  const images = findNoteImages(text)
  if (images.length === 0) return text
  let out = ''
  let at = 0
  for (const image of images) {
    out += text.slice(at, image.start) + imagePlaceholder(image)
    at = image.end
  }
  return out + text.slice(at)
}

/**
 * Turns the placeholders an agent kept back into the images of `current` (matched by text, in order, each image once),
 * so an agent's rewrite of a note does not delete the images it could not see.
 */
export function restoreImages(agentText: string, current: string): string {
  const originals = findNoteImages(current)
  if (originals.length === 0) return agentText
  const pool = originals.map((image) => ({
    placeholder: imagePlaceholder(image),
    markdown: current.slice(image.start, image.end),
    used: false,
  }))
  return agentText.replace(/\[image: [^[\]\n]*, \d+(?:\.\d)? (?:B|KB|MB)\]/g, (placeholder) => {
    const hit = pool.find((entry) => !entry.used && entry.placeholder === placeholder)
    if (!hit) return placeholder
    hit.used = true
    return hit.markdown
  })
}

/** The body as indexed for search: no embedded images and no stray base64 runs. */
export function forIndex(text: string): string {
  if (!text.includes('data:')) return text
  return withPlaceholders(text).replace(LOOSE, '')
}
