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

// Documents: just enough structure for the sniffer (a PDF header, a stored-entry ZIP with real directories).
export const pdf = (tag = 'x') => Buffer.from(`%PDF-1.7\n% ${tag}\n%%EOF\n`)

export function zip(names: string[]): Buffer {
  const locals: Buffer[] = []
  const centrals: Buffer[] = []
  let offset = 0
  for (const name of names) {
    const nameBytes = Buffer.from(name)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(nameBytes.length, 26)
    const central = Buffer.alloc(46)
    central.writeUInt32LE(0x02014b50, 0)
    central.writeUInt16LE(nameBytes.length, 28)
    central.writeUInt32LE(offset, 42)
    locals.push(local, nameBytes)
    centrals.push(central, nameBytes)
    offset += local.length + nameBytes.length
  }
  const directory = Buffer.concat(centrals)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(names.length, 8)
  end.writeUInt16LE(names.length, 10)
  end.writeUInt32LE(directory.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...locals, directory, end])
}
export const docx = () => zip(['[Content_Types].xml', 'word/document.xml'])
export const xlsx = () => zip(['[Content_Types].xml', 'xl/workbook.xml'])
