// Images inside a note (PLAN 6.8): picked, pasted or dropped files are decoded and downscaled in the browser and kept
// in the Markdown as `![alt](data:image/<type>;base64,...)`. Nothing is uploaded. The server re-checks every image.

export const IMAGE_TYPES = ['image/png', 'image/jpeg', 'image/gif', 'image/webp'] as const
export type ImageType = (typeof IMAGE_TYPES)[number]

export const MAX_SIDE = 1600
export const MAX_IMAGE_BYTES = 1.5 * 1024 * 1024
export const MAX_NOTE_BYTES = 8 * 1024 * 1024
/** An opaque PNG at most this big stays a PNG; larger ones become WebP or JPEG. */
const SMALL_PNG_BYTES = 256 * 1024
const QUALITY = 0.85

export type ImageProblem = 'type' | 'size' | 'decode' | 'note-size'

export class ImageError extends Error {
  readonly problem: ImageProblem
  constructor(problem: ImageProblem, message: string) {
    super(message)
    this.problem = problem
  }
}

const startsWith = (bytes: Uint8Array, at: number, signature: readonly number[]) =>
  signature.every((byte, index) => bytes[at + index] === byte)
const ascii = (text: string) => [...text].map((char) => char.charCodeAt(0))

/** The image type from the first bytes (never the file name or declared type). SVG and everything else is null. */
export function sniffImageType(bytes: Uint8Array): ImageType | null {
  if (startsWith(bytes, 0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return 'image/png'
  if (startsWith(bytes, 0, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (startsWith(bytes, 0, ascii('GIF87a')) || startsWith(bytes, 0, ascii('GIF89a')))
    return 'image/gif'
  if (startsWith(bytes, 0, ascii('RIFF')) && startsWith(bytes, 8, ascii('WEBP')))
    return 'image/webp'
  return null
}

export interface ImageSession {
  width: number
  height: number
  /** True when any pixel of the image drawn at this size is not fully opaque. */
  hasAlpha(width: number, height: number): Promise<boolean>
  /** The image drawn at this size and encoded; null when the browser cannot produce that type. */
  encode(width: number, height: number, type: ImageType, quality: number): Promise<Blob | null>
  close(): void
}
export type OpenImage = (file: Blob) => Promise<ImageSession>

/** The browser's decoder and canvas. Tests inject their own. */
export const openInBrowser: OpenImage = async (file) => {
  let bitmap: ImageBitmap
  try {
    bitmap = await createImageBitmap(file)
  } catch {
    throw new ImageError('decode', 'That image could not be read')
  }
  const canvasAt = (width: number, height: number) => {
    const canvas = document.createElement('canvas')
    canvas.width = width
    canvas.height = height
    const context = canvas.getContext('2d', { willReadFrequently: true })
    if (!context) throw new ImageError('decode', 'This browser cannot resize images')
    context.drawImage(bitmap, 0, 0, width, height)
    return { canvas, context }
  }
  return {
    width: bitmap.width,
    height: bitmap.height,
    async hasAlpha(width, height) {
      const { context } = canvasAt(width, height)
      const { data } = context.getImageData(0, 0, width, height)
      for (let index = 3; index < data.length; index += 4) if (data[index]! < 255) return true
      return false
    },
    encode(width, height, type, quality) {
      const { canvas } = canvasAt(width, height)
      return new Promise((resolve) => canvas.toBlob(resolve, type, quality))
    },
    close: () => bitmap.close(),
  }
}

export function toDataUri(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const reader = new FileReader()
    reader.onerror = () => reject(new ImageError('decode', 'That image could not be read'))
    reader.onload = () => resolve(String(reader.result))
    reader.readAsDataURL(blob)
  })
}

/** Alt text from a file name: `Team photo.png` -> `Team photo`; brackets and line breaks would break the syntax. */
export function altFromName(name: string): string {
  return (
    name
      .replace(/\.[A-Za-z0-9]+$/, '')
      .replace(/[[\]\r\n]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim() || 'image'
  )
}

export function escapeAlt(alt: string): string {
  return alt.replace(/[[\]\r\n]+/g, ' ').trim()
}

export interface PreparedImage {
  alt: string
  type: ImageType
  bytes: number
  /** `![alt](data:...)` */
  markdown: string
}

const fitWithin = (width: number, height: number, scale: number) => ({
  width: Math.max(1, Math.round(width * scale)),
  height: Math.max(1, Math.round(height * scale)),
})

export async function prepareImage(
  file: File,
  open: OpenImage = openInBrowser,
): Promise<PreparedImage> {
  const head = new Uint8Array(await file.slice(0, 16).arrayBuffer())
  const source = sniffImageType(head)
  if (!source)
    throw new ImageError(
      'type',
      'Only PNG, JPEG, GIF and WebP images can be added (SVG is not allowed)',
    )
  const session = await open(file)
  try {
    const longest = Math.max(session.width, session.height)
    let scale = Math.min(1, MAX_SIDE / longest)
    // Animated GIFs would lose their motion in a canvas: an untouched small one is kept as it is.
    if (source === 'image/gif' && scale === 1 && file.size <= MAX_IMAGE_BYTES)
      return finish(file, source, file)
    for (let attempt = 0; attempt < 6; attempt += 1) {
      const size = fitWithin(session.width, session.height, scale)
      const blob = await bestEncoding(session, source, size.width, size.height, attempt)
      if (blob && blob.size <= MAX_IMAGE_BYTES) return finish(file, blob.type as ImageType, blob)
      scale *= 0.8
    }
    throw new ImageError('size', 'That image is too large to keep in a note (1.5 MB at most)')
  } finally {
    session.close()
  }
}

async function bestEncoding(
  session: ImageSession,
  source: ImageType,
  width: number,
  height: number,
  attempt: number,
): Promise<Blob | null> {
  const quality = attempt === 0 ? QUALITY : Math.max(0.5, QUALITY - 0.1 * attempt)
  if (source === 'image/jpeg') return session.encode(width, height, 'image/jpeg', quality)
  const alpha = await session.hasAlpha(width, height)
  const png = await session.encode(width, height, 'image/png', 1)
  if (alpha) {
    if (png && png.size <= MAX_IMAGE_BYTES) return png
    // Transparency has to survive: WebP keeps it, JPEG would not.
    const webp = await session.encode(width, height, 'image/webp', quality)
    return webp?.type === 'image/webp' ? webp : png
  }
  if (png && png.size <= SMALL_PNG_BYTES) return png
  const candidates = [png]
  const webp = await session.encode(width, height, 'image/webp', quality)
  if (webp?.type === 'image/webp') candidates.push(webp)
  candidates.push(await session.encode(width, height, 'image/jpeg', quality))
  return candidates
    .filter((blob): blob is Blob => blob !== null)
    .reduce<Blob | null>((best, blob) => (!best || blob.size < best.size ? blob : best), null)
}

async function finish(file: File, type: ImageType, blob: Blob): Promise<PreparedImage> {
  const typed = blob.type === type ? blob : new Blob([blob], { type })
  const uri = await toDataUri(typed)
  const alt = altFromName(file.name)
  return { alt, type, bytes: blob.size, markdown: `![${alt}](${uri})` }
}

/** Decoded size of a `data:` URI's base64 payload. */
export function dataUriBytes(uri: string): number {
  const payload = uri.slice(uri.indexOf(',') + 1)
  const padding = payload.endsWith('==') ? 2 : payload.endsWith('=') ? 1 : 0
  return Math.floor((payload.length * 3) / 4) - padding
}

export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${Math.max(1, Math.round(bytes / 1024))} KB`
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`
}

/** The chip text for an embedded image in Source mode: `data:image/png · 240 KB`. */
export function chipLabel(uri: string): string {
  const type = /^data:([^;,]*)/.exec(uri)?.[1] ?? 'image'
  return `data:${type} · ${formatBytes(dataUriBytes(uri))}`
}

/** `![alt](data:image/...)` as it appears in Markdown; the same shape the server checks. */
export const EMBEDDED_IMAGE =
  /!\[([^\]\n]*)\]\((data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]*)\)/g

/** Text for people to read (diffs): every embedded image shortened to its chip label. */
export function collapseDataUris(text: string): string {
  if (!text.includes('data:image/')) return text
  return text.replace(/data:image\/[a-z0-9.+-]+;base64,[A-Za-z0-9+/=]{200,}/g, (uri) =>
    chipLabel(uri),
  )
}
