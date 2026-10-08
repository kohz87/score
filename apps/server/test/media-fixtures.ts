import { randomBytes } from 'node:crypto'

// Tiny byte fixtures with real magic numbers; the tail makes each one unique (content-addressed store).
export function png(pad = 64, seed = 0): Buffer {
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    Buffer.alloc(pad, seed),
  ])
}
export const jpeg = (pad = 64, seed = 1) =>
  Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(pad, seed)])
export const gif = (pad = 64, seed = 2) =>
  Buffer.concat([Buffer.from('GIF89a'), Buffer.alloc(pad, seed)])
export const webp = (pad = 64, seed = 3) =>
  Buffer.concat([
    Buffer.from('RIFF'),
    Buffer.alloc(4, 0),
    Buffer.from('WEBP'),
    Buffer.alloc(pad, seed),
  ])
export const unique = (size: number) => png(size - 8, 0).fill(randomBytes(1)[0]!, 8)

export function multipart(
  parts: { name: string; filename?: string; type?: string; data: Buffer }[],
  boundary = 'XBOUNDARYX',
): { body: Buffer; contentType: string } {
  const chunks: Buffer[] = []
  for (const part of parts) {
    chunks.push(
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="${part.name}"${
          part.filename === undefined ? '' : `; filename="${part.filename}"`
        }\r\n${part.type ? `Content-Type: ${part.type}\r\n` : ''}\r\n`,
      ),
      part.data,
      Buffer.from('\r\n'),
    )
  }
  chunks.push(Buffer.from(`--${boundary}--\r\n`))
  return { body: Buffer.concat(chunks), contentType: `multipart/form-data; boundary=${boundary}` }
}
