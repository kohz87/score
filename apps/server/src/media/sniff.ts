export type MediaType = 'image/png' | 'image/jpeg' | 'image/webp' | 'image/gif'

const PNG = [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]

function startsWith(bytes: Uint8Array, at: number, signature: readonly number[]): boolean {
  return bytes.length >= at + signature.length && signature.every((b, i) => bytes[at + i] === b)
}
const ascii = (text: string) => [...text].map((char) => char.charCodeAt(0))

// The declared type is never trusted: the content type served later comes from these magic bytes only.
export function sniffImage(bytes: Uint8Array): MediaType | null {
  if (startsWith(bytes, 0, PNG)) return 'image/png'
  if (startsWith(bytes, 0, [0xff, 0xd8, 0xff])) return 'image/jpeg'
  if (startsWith(bytes, 0, ascii('GIF87a')) || startsWith(bytes, 0, ascii('GIF89a')))
    return 'image/gif'
  if (startsWith(bytes, 0, ascii('RIFF')) && startsWith(bytes, 8, ascii('WEBP')))
    return 'image/webp'
  return null
}

// Declared types are only a consistency check: a lying label is rejected, an absent or generic one is ignored.
export function declaredMatches(declared: string | undefined, sniffed: MediaType): boolean {
  const value = declared?.split(';', 1)[0]?.trim().toLowerCase()
  if (!value || value === 'application/octet-stream') return true
  return (value === 'image/jpg' ? 'image/jpeg' : value) === sniffed
}
