import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { afterEach, beforeEach, describe, expect, test, vi } from 'vitest'
import { HttpError } from '../../src/errors.ts'
import { MAX_READ_BYTES, MAX_STORE_BYTES } from '../../src/knowledge/doc-types.ts'
import { PNG, makeZip, textDocx } from './doc-fixtures.ts'
import { makeVault, type Harness } from './helpers.ts'

// PLAN 10.6: big files are stored, hashed and served from disk; text work stops at MAX_READ_BYTES.
const worker = vi.hoisted(() => ({ text: vi.fn(), run: vi.fn() }))
vi.mock('../../src/knowledge/extract.ts', async (original) => {
  const real = await original<typeof import('../../src/knowledge/extract.ts')>()
  return {
    ...real,
    extractDocumentText: (...args: Parameters<typeof real.extractDocumentText>) => {
      worker.text(args[0])
      return real.extractDocumentText(...args)
    },
    runWorker: (...args: Parameters<typeof real.runWorker>) => {
      worker.run(args[0].op)
      return real.runWorker(...args)
    },
  }
})

vi.setConfig({ testTimeout: 60_000 })
const MB = 1024 * 1024

let h: Harness
beforeEach(async () => {
  worker.text.mockClear()
  worker.run.mockClear()
  h = await makeVault()
})
afterEach(async () => {
  await h.cleanup()
})

const failure = async (work: Promise<unknown>): Promise<HttpError> => {
  try {
    await work
  } catch (error) {
    if (error instanceof HttpError) return error
    throw error
  }
  throw new Error('expected a failure')
}
const bigPng = (mb: number) => Buffer.concat([PNG, Buffer.alloc(mb * MB)])
const bigPdf = (mb: number) => Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.alloc(mb * MB)])

describe('limits', () => {
  test('the limits are 256 MB to store and 25 MB to read', () => {
    expect(MAX_STORE_BYTES).toBe(256 * MB)
    expect(MAX_READ_BYTES).toBe(25 * MB)
  })

  test('a 100 MB upload is stored with too_large and never sent to a worker', async () => {
    const png = bigPng(100)
    const result = await h.vault.docs.upload('big.png', png, 'ask')
    expect(result).toMatchObject({ path: 'big.png', kind: 'document', history: 'not_versioned' })
    expect(fs.statSync(path.join(h.vaultDir, 'big.png')).size).toBe(png.length)
    expect(await h.vault.docs.get('big.png')).toMatchObject({
      size: png.length,
      textStatus: 'too_large',
      text: '',
    })
  })

  test('a PDF over 25 MB is not read for text', async () => {
    await h.vault.docs.upload('big.pdf', bigPdf(26), 'ask')
    expect(worker.text).not.toHaveBeenCalled()
    expect(await h.vault.docs.get('big.pdf')).toMatchObject({
      textStatus: 'too_large',
      text: '',
    })
  })

  test('a CSV just over 25 MB is stored without text, one at 25 MB is indexed', async () => {
    const row = 'a,b,c\n'
    const over = Buffer.from(row.repeat(Math.ceil((MAX_READ_BYTES + 1) / row.length)))
    await h.vault.docs.upload('over.csv', over, 'ask')
    expect(await h.vault.docs.get('over.csv')).toMatchObject({ textStatus: 'too_large', text: '' })
    const small = await h.vault.docs.upload('small.csv', Buffer.from('x,y\n1,2\n'), 'ask')
    expect(small.kind).toBe('document')
    expect((await h.vault.docs.get('small.csv')).textStatus).toBe('indexed')
  })

  test('over 256 MB is refused with 413', async () => {
    const error = await failure(
      h.vault.docs.upload('huge.png', Buffer.alloc(MAX_STORE_BYTES + 1), 'ask'),
    )
    expect(error.status).toBe(413)
    expect(error.message).toContain('256 MB')
  })
})

describe('reading from disk', () => {
  test('re-indexing and the scanner treat a big outside file the same, without a worker', async () => {
    fs.writeFileSync(path.join(h.vaultDir, 'dropped.pdf'), bigPdf(30))
    await h.vault.scanNow(true)
    expect(worker.text).not.toHaveBeenCalled()
    expect(await h.vault.docs.get('dropped.pdf')).toMatchObject({ textStatus: 'too_large' })
    // Same bytes again: unchanged, and a rebuild keeps the status.
    await h.vault.rebuild()
    expect(worker.text).not.toHaveBeenCalled()
    expect((await h.vault.docs.get('dropped.pdf')).textStatus).toBe('too_large')
  })

  test('hashContained streams: same hash as the bytes, refuses a symlink and a file over the cap', async () => {
    const abs = path.join(h.vaultDir, 'x.bin')
    const bytes = Buffer.alloc(3 * MB, 5)
    fs.writeFileSync(abs, bytes)
    expect(await h.vault.hashContained(abs, MAX_STORE_BYTES)).toBe(
      createHash('sha256').update(bytes).digest('hex'),
    )
    await expect(h.vault.hashContained(abs, MB)).rejects.toMatchObject({ status: 413 })
    const link = path.join(h.vaultDir, 'link.bin')
    fs.symlinkSync(abs, link)
    await expect(h.vault.hashContained(link, MAX_STORE_BYTES)).rejects.toBeDefined()
  })

  test('opening a document gives a stream, not a buffer', async () => {
    const png = bigPng(30)
    await h.vault.docs.upload('s.png', png, 'ask')
    const read = vi.spyOn(h.vault, 'readContainedBuffer')
    const file = await h.vault.docs.open('s.png')
    expect(read).not.toHaveBeenCalled()
    expect(file).toMatchObject({ size: png.length, type: 'image', name: 's.png' })
    expect(typeof file.stream.pipe).toBe('function')
    expect(file.head.subarray(0, 8).equals(PNG.subarray(0, 8))).toBe(true)
    let total = 0
    for await (const chunk of file.stream) total += (chunk as Buffer).length
    expect(total).toBe(png.length)
  })
})

describe('re-indexing big files', () => {
  const bigDocx = async () => {
    const small = await textDocx('hello')
    // A real DOCX plus a stored filler part, so the central directory sits at the end of 30 MB.
    const JSZip = (await import('jszip')).default
    const zip = await JSZip.loadAsync(small)
    zip.file('word/filler.bin', Buffer.alloc(30 * MB, 1), { compression: 'STORE' })
    return zip.generateAsync({ type: 'nodebuffer', compression: 'STORE' })
  }

  test('a scan never reads a big CSV, JSON, DOCX or zip whole; it checks head and tail and marks them too_large', async () => {
    const line = '{"a":1,"b":"xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"}\n'
    fs.writeFileSync(path.join(h.vaultDir, 'a.csv'), 'x,y\n'.repeat(8 * MB))
    fs.writeFileSync(
      path.join(h.vaultDir, 'b.json'),
      line.repeat(Math.ceil((30 * MB) / line.length)),
    )
    fs.writeFileSync(path.join(h.vaultDir, 'c.html'), '<p>x</p>\n'.repeat(4 * MB))
    fs.writeFileSync(path.join(h.vaultDir, 'd.docx'), await bigDocx())
    fs.writeFileSync(
      path.join(h.vaultDir, 'e.zip'),
      await makeZip({ 'f.png': bigPng(30) }, 'STORE'),
    )
    fs.writeFileSync(path.join(h.vaultDir, 'fake.docx'), Buffer.alloc(30 * MB))
    const read = vi.spyOn(h.vault, 'readContainedBuffer')
    await h.vault.scanNow(true)
    const wholeFileReads = read.mock.calls.filter(([, max]) => (max ?? 0) > MAX_READ_BYTES)
    expect(wholeFileReads).toEqual([])
    for (const name of ['a.csv', 'b.json', 'c.html', 'd.docx', 'e.zip'])
      expect(await h.vault.docs.get(name), name).toMatchObject({ textStatus: 'too_large' })
    // A file that is not what its name says is still left unlisted.
    await expect(h.vault.docs.get('fake.docx')).rejects.toMatchObject({ status: 404 })
    expect(worker.text).not.toHaveBeenCalled()
  })
})

describe('big zips', () => {
  test('a 100 MB zip previews, is kept and unzips (its entry is a document)', async () => {
    const zip = await makeZip({ 'big.png': bigPng(100), 'note.md': '# n' }, 'STORE')
    expect(zip.length).toBeGreaterThan(100 * MB)
    const preview = await h.vault.docs.zipPreview(zip)
    expect(preview.extractCount).toBe(2)
    const kept = await h.vault.docs.upload('pack.zip', zip, 'ask')
    expect(kept.kind).toBe('document')
    expect(await h.vault.docs.get('pack.zip')).toMatchObject({
      textStatus: 'too_large',
      entries: expect.arrayContaining([expect.objectContaining({ path: 'big.png' })]),
    })
    const result = await h.vault.docs.unzip(zip, 'pack.zip', 'pack', 'ask')
    expect(result.written.sort()).toEqual(['pack/big.png', 'pack/note.md'])
    expect(fs.statSync(path.join(h.vaultDir, 'pack/big.png')).size).toBe(PNG.length + 100 * MB)
    expect((await h.vault.docs.get('pack/big.png')).textStatus).toBe('too_large')
  })

  test('an entry over 256 MB is skipped, one at exactly the limit is not part of this test', async () => {
    // Lowering the cap keeps the test fast: the worker honours limits.maxFileBytes.
    const { runWorker, ZIP_LIMITS } = await import('../../src/knowledge/extract.ts')
    const zip = await makeZip({ 'a.png': bigPng(3), 'b.png': PNG }, 'STORE')
    const out = await runWorker(
      { op: 'zip-list', bytes: zip, limits: { ...ZIP_LIMITS, maxFileBytes: 2 * MB } },
      30_000,
    )
    expect(out).toMatchObject({ ok: true })
    const entries = (out as { entries: Array<{ path: string; action: string; reason: string }> })
      .entries
    expect(entries.find((e) => e.path === 'a.png')).toMatchObject({
      action: 'skip',
      reason: 'file too large',
    })
    expect(entries.find((e) => e.path === 'b.png')?.action).toBe('extract')
  })

  test('a zip declaring more than 1 GB unpacked is 413 zip_limits without inflating it', async () => {
    const zip = lyingZip(6, 200 * MB, 2 * MB + 100_000)
    const error = await failure(h.vault.docs.zipPreview(zip))
    expect(error).toMatchObject({ status: 413, code: 'zip_limits' })
    expect(error.message).toContain('1024 MB')
    expect((await failure(h.vault.docs.unzip(zip, 'z.zip', 'z', 'ask'))).status).toBe(413)
  })
})

/** A zip whose central directory declares `count` stored entries of `size` bytes, each with `packed` bytes of data. */
function lyingZip(count: number, size: number, packed: number): Buffer {
  const parts: Buffer[] = []
  const central: Buffer[] = []
  let offset = 0
  for (let i = 0; i < count; i += 1) {
    const name = Buffer.from(`e${i}.png`)
    const local = Buffer.alloc(30)
    local.writeUInt32LE(0x04034b50, 0)
    local.writeUInt16LE(20, 4)
    local.writeUInt32LE(packed, 18)
    local.writeUInt32LE(size, 22)
    local.writeUInt16LE(name.length, 26)
    const data = Buffer.alloc(packed)
    const entry = Buffer.alloc(46)
    entry.writeUInt32LE(0x02014b50, 0)
    entry.writeUInt16LE(20, 4)
    entry.writeUInt16LE(20, 6)
    entry.writeUInt32LE(packed, 20)
    entry.writeUInt32LE(size, 24)
    entry.writeUInt16LE(name.length, 28)
    entry.writeUInt32LE(offset, 42)
    central.push(entry, name)
    parts.push(local, name, data)
    offset += 30 + name.length + packed
  }
  const dir = Buffer.concat(central)
  const end = Buffer.alloc(22)
  end.writeUInt32LE(0x06054b50, 0)
  end.writeUInt16LE(count, 8)
  end.writeUInt16LE(count, 10)
  end.writeUInt32LE(dir.length, 12)
  end.writeUInt32LE(offset, 16)
  return Buffer.concat([...parts, dir, end])
}
