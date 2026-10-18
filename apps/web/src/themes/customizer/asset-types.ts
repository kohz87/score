// The picture and font types a theme may carry (design §1), judged by their first bytes as the server does.

const starts = (bytes: Uint8Array, at: number, text: string) =>
  bytes.length >= at + text.length &&
  [...text].every((char, index) => bytes[at + index] === char.charCodeAt(0))

export type AssetKind = 'woff2' | 'png' | 'jpg' | 'webp' | 'avif'

export function sniffAsset(bytes: Uint8Array): AssetKind | null {
  if (starts(bytes, 0, 'wOF2')) return 'woff2'
  if (
    bytes.length >= 8 &&
    [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a].every((b, i) => bytes[i] === b)
  )
    return 'png'
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return 'jpg'
  if (starts(bytes, 0, 'RIFF') && starts(bytes, 8, 'WEBP')) return 'webp'
  if (starts(bytes, 4, 'ftypavif')) return 'avif'
  return null
}

export const mimeOf: Record<AssetKind, string> = {
  woff2: 'font/woff2',
  png: 'image/png',
  jpg: 'image/jpeg',
  webp: 'image/webp',
  avif: 'image/avif',
}

export function mimeForPath(path: string): string {
  const ext = path.slice(path.lastIndexOf('.') + 1).toLowerCase()
  return ext === 'woff2'
    ? mimeOf.woff2
    : ext === 'png'
      ? mimeOf.png
      : ext === 'jpg' || ext === 'jpeg'
        ? mimeOf.jpg
        : ext === 'webp'
          ? mimeOf.webp
          : mimeOf.avif
}

export const MAX_ASSET_BYTES = 8 * 1024 * 1024

export function toDataUrl(bytes: Uint8Array, mime: string): string {
  let binary = ''
  const step = 0x8000
  for (let i = 0; i < bytes.length; i += step)
    binary += String.fromCharCode(...bytes.subarray(i, i + step))
  return `data:${mime};base64,${btoa(binary)}`
}

const dataUrls = new WeakMap<Uint8Array, string>()
/** The data address of a file added in this session, made once per file. */
export function dataUrlFor(bytes: Uint8Array, path: string): string {
  let url = dataUrls.get(bytes)
  if (!url) {
    url = toDataUrl(bytes, mimeForPath(path))
    dataUrls.set(bytes, url)
  }
  return url
}
