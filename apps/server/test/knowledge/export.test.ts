import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, test, vi } from 'vitest'
import JSZip from 'jszip'
import {
  exportStream,
  planExport,
  MAX_EXPORT_BYTES,
  MAX_EXPORT_FILES,
} from '../../src/knowledge/export.ts'

vi.setConfig({ testTimeout: 60_000 })
let dir = ''
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }))
const root = () => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'score-export-'))
  return dir
}

describe('export limits and streaming', () => {
  test('too many files or bytes is refused from stored sizes, before any stream exists', async () => {
    const r = root()
    fs.writeFileSync(path.join(r, 'a.md'), 'a')
    const many = Array.from({ length: MAX_EXPORT_FILES + 1 }, (_, i) => `f${i}.md`)
    await expect(planExport(r, many, { all: true })).rejects.toMatchObject({
      status: 413,
      code: 'export_too_large',
    })
    // A sparse file reports a huge size without using disk.
    fs.writeFileSync(path.join(r, 'big.pdf'), '')
    fs.truncateSync(path.join(r, 'big.pdf'), MAX_EXPORT_BYTES + 1)
    await expect(planExport(r, ['a.md', 'big.pdf'], { all: true })).rejects.toMatchObject({
      status: 413,
      details: { files: 2 },
    })
  })

  test('a large file is streamed without holding it in memory', async () => {
    const r = root()
    const size = 160 * 1024 * 1024
    const file = path.join(r, 'large.csv')
    const fd = fs.openSync(file, 'w')
    const chunk = Buffer.alloc(1024 * 1024, 'abc,123\n')
    for (let i = 0; i < size / chunk.length; i++) fs.writeSync(fd, chunk)
    fs.closeSync(fd)
    const plan = await planExport(r, ['large.csv'], { all: true })
    global.gc?.()
    const before = process.memoryUsage().rss
    let peak = before
    let total = 0
    const out = exportStream(r, plan, new Date())
    const dest = path.join(r, 'out.zip')
    const sink = fs.createWriteStream(dest)
    await new Promise<void>((resolve, reject) => {
      out.on('data', (buf: Buffer) => {
        total += buf.length
        peak = Math.max(peak, process.memoryUsage().rss)
      })
      out.on('error', reject)
      out.pipe(sink).on('finish', resolve)
    })
    expect(total).toBeGreaterThan(0)
    expect(peak - before).toBeLessThan(size / 2)
    const zip = await JSZip.loadAsync(fs.readFileSync(dest))
    expect((await zip.file('large.csv')!.async('nodebuffer')).length).toBe(size)
  })

  test('a symlink swapped in after planning fails the stream', async () => {
    const r = root()
    fs.writeFileSync(path.join(r, 'a.md'), 'a')
    fs.writeFileSync(path.join(r, 'target.md'), 'secret')
    const plan = await planExport(r, ['a.md'], { all: true })
    fs.rmSync(path.join(r, 'a.md'))
    fs.symlinkSync(path.join(r, 'target.md'), path.join(r, 'a.md'))
    const out = exportStream(r, plan, new Date())
    await expect(
      new Promise((resolve, reject) => {
        out.on('error', reject)
        out.on('end', resolve)
        out.resume()
      }),
    ).rejects.toBeTruthy()
  })
})
