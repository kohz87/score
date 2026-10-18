import JSZip from 'jszip'

export const PNG = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.from('png body'),
])
export const WOFF2 = Buffer.concat([Buffer.from('wOF2'), Buffer.from('font body')])
export const WEBP = Buffer.concat([
  Buffer.from('RIFF'),
  Buffer.from([1, 0, 0, 0]),
  Buffer.from('WEBPVP8 '),
])
export const AVIF = Buffer.concat([
  Buffer.from([0, 0, 0, 0x1c]),
  Buffer.from('ftypavif'),
  Buffer.from('....'),
])
export const JPEG = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 1, 2, 3])
export const manifestJson = (extra: object = {}) =>
  JSON.stringify({ format: 1, id: 'seaside', name: 'Seaside', ...extra })

export type Entry = string | Buffer | { data: string | Buffer; unixPermissions?: number }
/** Builds a zip from raw names, so traversal and odd paths survive into the archive. */
export async function zipOf(
  entries: Record<string, Entry>,
  generate: { compression?: 'STORE' | 'DEFLATE' } = {},
): Promise<Buffer> {
  const zip = new JSZip()
  for (const [name, entry] of Object.entries(entries)) {
    const { data, unixPermissions } =
      typeof entry === 'string' || Buffer.isBuffer(entry) ? { data: entry } : entry
    zip.file(name, data, { ...(unixPermissions ? { unixPermissions } : {}), createFolders: false })
  }
  return zip.generateAsync({
    type: 'nodebuffer',
    platform: 'UNIX',
    compression: generate.compression ?? 'DEFLATE',
  })
}
