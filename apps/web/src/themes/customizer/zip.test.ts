import { deflateRawSync } from 'node:zlib'
import { describe, expect, it } from 'vitest'
import { crc32, readZip, writeZip, ZipError } from './zip.ts'

const text = (value: string) => new TextEncoder().encode(value)

/** One deflated entry, the way the server's export writes theme.json. */
function deflatedZip(name: string, content: Uint8Array): Uint8Array {
  const packed = deflateRawSync(content)
  const nameBytes = text(name)
  const local = new Uint8Array(30 + nameBytes.length)
  const lv = new DataView(local.buffer)
  lv.setUint32(0, 0x04034b50, true)
  lv.setUint16(4, 20, true)
  lv.setUint16(8, 8, true)
  lv.setUint32(14, crc32(content), true)
  lv.setUint32(18, packed.length, true)
  lv.setUint32(22, content.length, true)
  lv.setUint16(26, nameBytes.length, true)
  local.set(nameBytes, 30)
  const entry = new Uint8Array(46 + nameBytes.length)
  const cv = new DataView(entry.buffer)
  cv.setUint32(0, 0x02014b50, true)
  cv.setUint16(4, 20, true)
  cv.setUint16(6, 20, true)
  cv.setUint16(10, 8, true)
  cv.setUint32(16, crc32(content), true)
  cv.setUint32(20, packed.length, true)
  cv.setUint32(24, content.length, true)
  cv.setUint16(28, nameBytes.length, true)
  cv.setUint32(42, 0, true)
  entry.set(nameBytes, 46)
  const end = new Uint8Array(22)
  const ev = new DataView(end.buffer)
  ev.setUint32(0, 0x06054b50, true)
  ev.setUint16(8, 1, true)
  ev.setUint16(10, 1, true)
  ev.setUint32(12, entry.length, true)
  ev.setUint32(16, local.length + packed.length, true)
  return Uint8Array.from([...local, ...packed, ...entry, ...end])
}

describe('zip', () => {
  it('reads back what it writes', async () => {
    const zip = writeZip([
      ['theme.json', text('{"a":1}')],
      ['assets/img/a.png', Uint8Array.from([1, 2, 3, 4])],
    ])
    const files = await readZip(zip)
    expect([...files.keys()]).toEqual(['theme.json', 'assets/img/a.png'])
    expect(new TextDecoder().decode(files.get('theme.json'))).toBe('{"a":1}')
    expect([...files.get('assets/img/a.png')!]).toEqual([1, 2, 3, 4])
  })

  it('reads a deflated entry', async () => {
    const content = text('{"format":1,"id":"x","name":"X"}'.repeat(20))
    const files = await readZip(deflatedZip('theme.json', content))
    expect(new TextDecoder().decode(files.get('theme.json'))).toBe(
      new TextDecoder().decode(content),
    )
  })

  it('refuses paths that leave the folder, and non-zips', async () => {
    await expect(readZip(writeZip([['../evil.css', text('a')]]))).rejects.toBeInstanceOf(ZipError)
    await expect(readZip(writeZip([['a\\b.css', text('a')]]))).rejects.toBeInstanceOf(ZipError)
    await expect(readZip(text('not a zip at all'))).rejects.toBeInstanceOf(ZipError)
  })

  it('refuses too many files and oversize entries', async () => {
    const many = writeZip(
      Array.from({ length: 5 }, (_, i): [string, Uint8Array] => [`f${i}.css`, text('a')]),
    )
    await expect(readZip(many, { entries: 3, fileBytes: 100, totalBytes: 1000 })).rejects.toThrow(
      /more files/,
    )
    const big = writeZip([['a.css', new Uint8Array(200)]])
    await expect(readZip(big, { entries: 3, fileBytes: 100, totalBytes: 1000 })).rejects.toThrow(
      /too large/,
    )
  })
})
