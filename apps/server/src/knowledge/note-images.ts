import { KNOWLEDGE_IMAGE_MAX_BYTES, KNOWLEDGE_IMAGE_TYPES } from '@score/contract'
import { HttpError } from '../errors.ts'
import { MAX_NOTE_BYTES } from './note.ts'
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

/** The placeholder text without its number: `alt, 69 B`. */
function placeholderLabel(image: NoteImage): string {
  const payload = DATA_URI.exec(image.uri)?.[3] ?? ''
  const alt = image.alt.replace(/[[\]\n]/g, ' ').trim() || 'image'
  return `${alt}, ${formatImageSize(base64Bytes(payload) ?? payload.length)}`
}

/**
 * What an agent sees instead of an image: `[image 2: <alt>, <size>]`, where 2 is the image's place in the note (the
 * 2nd embedded image as the agent read it). Two images with the same label still have different numbers.
 */
export function imagePlaceholder(image: NoteImage, index: number): string {
  return `[image ${index}: ${placeholderLabel(image)}]`
}

/** The note with every embedded image replaced by its numbered placeholder. */
export function withPlaceholders(text: string): string {
  const images = findNoteImages(text)
  if (images.length === 0) return text
  let out = ''
  let at = 0
  images.forEach((image, i) => {
    out += text.slice(at, image.start) + imagePlaceholder(image, i + 1)
    at = image.end
  })
  return out + text.slice(at)
}

const PLACEHOLDER = /\[image(?: (\d+))?: ([^[\]\n]*, \d+(?:\.\d)? (?:B|KB|MB))\]/g

/**
 * Turns the placeholders an agent kept back into the images of `current`, so an agent's rewrite of a note does not
 * delete the images it could not see. `[image 2: ...]` restores the note's 2nd image, and only when that image's
 * label still matches; a number the note doesn't have, a label that doesn't match, or a number used twice stays text,
 * never another image. An old `[image: ...]` (no number) restores only when exactly one image has that label;
 * otherwise the write is refused, because guessing could swap two images.
 */
export function restoreImages(agentText: string, current: string): string {
  const originals = findNoteImages(current)
  if (originals.length === 0) return agentText
  const labels = originals.map(placeholderLabel)
  const used = new Set<number>()
  const restore = (index: number): string => {
    used.add(index)
    return current.slice(originals[index]!.start, originals[index]!.end)
  }
  // One pass, so restored image text is never scanned for placeholders again.
  return agentText.replace(
    PLACEHOLDER,
    (placeholder, number: string | undefined, label: string) => {
      if (number !== undefined) {
        const index = Number(number) - 1
        if (index < 0 || index >= originals.length || used.has(index) || labels[index] !== label)
          return placeholder
        return restore(index)
      }
      const matches = labels.flatMap((item, index) => (item === label ? [index] : []))
      if (matches.length === 0) return placeholder
      if (matches.length > 1)
        throw new HttpError(
          409,
          'ambiguous_image',
          `Score can’t tell which image “${placeholder}” stands for, because the note has more than one with that name and size. Read the note again (the placeholders now carry numbers like [image 1: ...]), then write it again.`,
        )
      return used.has(matches[0]!) ? placeholder : restore(matches[0]!)
    },
  )
}

/** The body as indexed for search: no embedded images and no stray base64 runs. */
export function forIndex(text: string): string {
  if (!text.includes('data:')) return text
  return withPlaceholders(text).replace(LOOSE, '')
}

/** The checks every way of putting a note on disk shares (saves, uploads, zip imports): size, then embedded images. */
export function prepareNoteContent(content: string): void {
  if (Buffer.byteLength(content) > MAX_NOTE_BYTES)
    throw new HttpError(413, 'payload_too_large', 'That note is too large.')
  validateNoteImages(content)
}
