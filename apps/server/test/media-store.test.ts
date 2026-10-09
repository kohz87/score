import { createHash } from 'node:crypto'
import {
  existsSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
  unlinkSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { migrate, openDatabase, type ScoreDb } from '../src/db/index.ts'
import { HttpError } from '../src/errors.ts'
import { MediaStore } from '../src/media/store.ts'
import { sniffImage } from '../src/media/sniff.ts'
import { gif, jpeg, png, webp } from './media-fixtures.ts'

const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('hex')
let dir: string
let db: ScoreDb
let now: number
let store: MediaStore
const make = (quotaBytes = 1000, maxItemBytes = 1000) =>
  new MediaStore(db, join(dir, 'media'), { quotaBytes, maxItemBytes, clock: () => now })

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'score-media-'))
  db = openDatabase(join(dir, 'score.db'))
  migrate(db, fileURLToPath(new URL('../migrations/', import.meta.url)))
  now = Date.parse('2026-10-08T10:00:00.000Z')
  store = make()
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const code = (fn: () => unknown) => {
  try {
    fn()
  } catch (error) {
    if (error instanceof HttpError) return `${error.status} ${error.code}`
    throw error
  }
  return 'ok'
}
const sized = (seed: number, size: number) => png(size - 8, seed)
const files = () => readdirSync(join(dir, 'media')).sort()

test('sniffs magic bytes and ignores everything else', () => {
  expect([png(), jpeg(), gif(), webp()].map(sniffImage)).toEqual([
    'image/png',
    'image/jpeg',
    'image/gif',
    'image/webp',
  ])
  expect(sniffImage(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"/>'))).toBeNull()
  expect(sniffImage(Buffer.from('<html><script>alert(1)</script>'))).toBeNull()
  expect(sniffImage(Buffer.from('RIFF....WAVE'))).toBeNull()
  expect(sniffImage(Buffer.alloc(0))).toBeNull()
})

test('the declared type is a consistency check, never the source of the served type', () => {
  expect(code(() => store.store(Buffer.from('<svg/>'), 'image/png'))).toBe(
    '415 unsupported_media_type',
  )
  expect(code(() => store.store(png(), 'image/svg+xml'))).toBe('415 unsupported_media_type')
  expect(code(() => store.store(png(), 'text/html'))).toBe('415 unsupported_media_type')
  const stored = store.store(jpeg(), 'application/octet-stream')
  expect(stored.contentType).toBe('image/jpeg')
  expect(store.store(jpeg(), 'image/jpg').mediaId).toBe(stored.mediaId)
})

test('limits: empty, per-item size', () => {
  store = make(1000, 400)
  expect(code(() => store.store(Buffer.alloc(0)))).toBe('400 bad_request')
  expect(code(() => store.store(sized(1, 400)))).toBe('ok')
  expect(code(() => store.store(sized(2, 401)))).toBe('413 payload_too_large')
})

test('stores content-addressed with private permissions and dedups', () => {
  const first = store.store(png())
  const again = store.store(png())
  expect(again.mediaId).toBe(first.mediaId)
  expect(files()).toHaveLength(1)
  expect(files()[0]).toMatch(/^[0-9a-f]{64}$/)
  expect(statSync(join(dir, 'media')).mode & 0o777).toBe(0o700)
  expect(statSync(join(dir, 'media', files()[0]!)).mode & 0o777).toBe(0o600)
  const read = store.read(first.mediaId)
  expect(read?.bytes.equals(png())).toBe(true)
  expect(read?.contentType).toBe('image/png')
})

test('read never turns request input into a path', () => {
  store.store(png())
  for (const id of [
    '../score.db',
    '..%2Fscore.db',
    '/etc/passwd',
    '.',
    '',
    'a'.repeat(36),
    files()[0]!,
  ])
    expect(store.read(id)).toBeNull()
})

test('over quota, the least recently used unreferenced item is evicted first', () => {
  const a = store.store(sized(1, 400))
  now += 1000
  const b = store.store(sized(2, 400))
  now += 1000
  expect(store.read(a.mediaId)).not.toBeNull() // touching A makes B the oldest
  now += 1000
  const c = store.store(sized(3, 400))
  expect(store.has(b.mediaId)).toBe(false)
  expect(store.has(a.mediaId)).toBe(true)
  expect(store.has(c.mediaId)).toBe(true)
  expect(store.totalBytes()).toBe(800)
  expect(files()).toHaveLength(2)
})

test('referenced items are never evicted; a store full of them refuses new items', () => {
  const a = store.store(sized(1, 500))
  const b = store.store(sized(2, 500))
  db.tx((sqlite) => store.retain(sqlite, [a.mediaId, b.mediaId], new Date(now).toISOString()))
  now += 5000
  expect(code(() => store.store(sized(3, 100)))).toBe('507 media_quota_exceeded')
  expect(store.has(a.mediaId) && store.has(b.mediaId)).toBe(true)
  expect(files()).toHaveLength(2)
  expect(store.totalBytes()).toBe(1000)
})

test('a failed store rolls back evictions and leaves no file behind', () => {
  const a = store.store(sized(1, 400))
  const b = store.store(sized(2, 400))
  db.tx((sqlite) => store.retain(sqlite, [b.mediaId], new Date(now).toISOString()))
  // Needs 700 free but only A (400) can go: 400 + 700 > 1000 even after evicting it.
  const big = make(1000, 800)
  expect(code(() => big.store(sized(9, 700)))).toBe('507 media_quota_exceeded')
  expect(store.has(a.mediaId)).toBe(true)
  expect(files()).toHaveLength(2)
})

test('retain rejects unknown ids so a message can never reference missing media', () => {
  expect(
    code(() => db.tx((sqlite) => store.retain(sqlite, ['nope'], new Date(now).toISOString()))),
  ).toBe('400 bad_request')
})

test('sweep expires unused items, enforces a lowered quota, and removes orphans and dangling rows', () => {
  const kept = store.store(sized(1, 100))
  db.tx((sqlite) => store.retain(sqlite, [kept.mediaId], new Date(now).toISOString()))
  const old = store.store(sized(2, 100))
  const gone = store.store(sized(3, 100))
  const dir_ = join(dir, 'media')
  // Row whose file vanished.
  unlinkSync(
    join(
      dir_,
      db.sqlite.prepare('SELECT sha256 FROM media WHERE id = ?').get(gone.mediaId)!
        .sha256 as string,
    ),
  )
  // Orphan (old) and fresh orphan.
  const orphan = join(dir_, 'f'.repeat(64))
  const fresh = join(dir_, 'e'.repeat(64))
  writeFileSync(orphan, 'x')
  writeFileSync(fresh, 'x')
  const past = new Date(now - 3600_000)
  utimesSync(orphan, past, past)
  now += 31 * 24 * 3600_000
  utimesSync(fresh, new Date(now), new Date(now))
  const result = store.sweep()
  expect(result).toMatchObject({ missing: 1, orphans: 1 })
  expect(store.has(old.mediaId)).toBe(false)
  expect(store.has(gone.mediaId)).toBe(false)
  expect(store.has(kept.mediaId)).toBe(true)
  expect(existsSync(orphan)).toBe(false)
  expect(existsSync(fresh)).toBe(true)
  // Lowered quota: the unreferenced extra goes, the referenced one stays even though still over.
  const extra = store.store(sized(4, 100))
  const tiny = new MediaStore(db, dir_, { quotaBytes: 50, clock: () => now })
  tiny.sweep()
  expect(tiny.has(extra.mediaId)).toBe(false)
  expect(tiny.has(kept.mediaId)).toBe(true)
})

test('re-uploading the original bytes repairs a damaged blob, and sweep keeps referenced ids', () => {
  const bytes = png(100)
  const first = store.store(bytes)
  const blob = join(dir, 'media', sha(bytes))
  writeFileSync(blob, '')
  expect(store.read(first.mediaId)).toBeNull()
  const again = store.store(bytes)
  expect(again.mediaId).toBe(first.mediaId)
  expect(store.read(first.mediaId)?.bytes.equals(bytes)).toBe(true)
  // a referenced row whose blob vanished survives the sweep; an unreferenced one does not
  db.tx((sqlite) => store.retain(sqlite, [first.mediaId], new Date(now).toISOString()))
  const other = store.store(png(120))
  unlinkSync(blob)
  unlinkSync(join(dir, 'media', sha(png(120))))
  expect(store.sweep().missing).toBe(1)
  expect(store.has(first.mediaId)).toBe(true)
  expect(store.has(other.mediaId)).toBe(false)
  expect(store.store(bytes).mediaId).toBe(first.mediaId)
  expect(store.read(first.mediaId)?.bytes.equals(bytes)).toBe(true)
})

test('identical text bytes keep a separate document type per upload name and share one blob', () => {
  const bytes = Buffer.from('a,b\n1,2\n')
  const txt = store.store(bytes, undefined, 'data.txt')
  const csv = store.store(bytes, undefined, 'data.csv')
  expect(txt.contentType).toBe('text/plain')
  expect(csv.contentType).toBe('text/csv')
  expect(csv.mediaId).not.toBe(txt.mediaId)
  expect(store.read(txt.mediaId)?.contentType).toBe('text/plain')
  expect(store.store(bytes, undefined, 'again.csv').mediaId).toBe(csv.mediaId)
  expect(readdirSync(join(dir, 'media')).filter((n) => n.length === 64)).toHaveLength(1)
  // the blob outlives the first expiry while the other row still uses it
  now += 40 * 24 * 3600 * 1000
  store.retain(db.sqlite, [csv.mediaId], new Date(now).toISOString())
  store.sweep()
  expect(store.read(csv.mediaId)?.bytes.equals(bytes)).toBe(true)
})
