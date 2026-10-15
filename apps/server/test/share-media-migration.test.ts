import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { migrate, openDatabase, type ScoreDb } from '../src/db/index.ts'

const SRC = fileURLToPath(new URL('../migrations/', import.meta.url))
let dir: string
let db: ScoreDb
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'score-share-media-mig-'))
  db = openDatabase(join(dir, 'score.db'))
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

// audit4-c #1: shares that are live when 0068 runs take their media references then.
test('0068 gives existing live shares their image references, once per distinct image', () => {
  const migrations = join(dir, 'migrations')
  mkdirSync(migrations)
  const files = readdirSync(SRC).filter((name) => name.endsWith('.sql'))
  for (const name of files) if (name < '0068') copyFileSync(join(SRC, name), join(migrations, name))
  migrate(db, migrations)

  const sqlite = db.sqlite
  sqlite.exec('PRAGMA foreign_keys = OFF')
  const media = sqlite.prepare(
    `INSERT INTO media (id, sha256, content_type, size, created_at, last_used_at, refs) VALUES (?, ?, 'image/png', 10, ?, ?, ?)`,
  )
  const at = '2026-10-01T00:00:00.000Z'
  media.run('m1', 'a'.repeat(64), at, at, 1) // also held by a message
  media.run('m2', 'b'.repeat(64), at, at, 0)
  media.run('m3', 'c'.repeat(64), at, at, 0)
  const share = sqlite.prepare(
    `INSERT INTO room_shares (id, room_id, token_hash, created_at, expires_at, revoked_at, include_images, snapshot)
     VALUES (?, 'r', ?, ?, ?, ?, ?, ?)`,
  )
  const snap = (images: string[]) => JSON.stringify({ title: '', messages: [], images })
  const future = '2999-01-01T00:00:00.000Z'
  share.run('live-a', 'h1', at, future, null, 1, snap(['m1', 'm2', 'm2', 'gone']))
  share.run('live-b', 'h2', at, future, null, 1, snap(['m2']))
  share.run('revoked', 'h3', at, future, at, 1, snap([]))
  share.run('expired', 'h4', at, '2026-10-02T00:00:00.000Z', null, 1, snap(['m3']))
  share.run('no-images', 'h5', at, future, null, 0, snap(['m3']))

  copyFileSync(join(SRC, '0068_share_media.sql'), join(migrations, '0068_share_media.sql'))
  migrate(db, migrations)

  expect(sqlite.prepare('SELECT share_id, media_id FROM share_media ORDER BY 1, 2').all()).toEqual([
    { share_id: 'live-a', media_id: 'm1' },
    { share_id: 'live-a', media_id: 'm2' },
    { share_id: 'live-b', media_id: 'm2' },
  ])
  expect(sqlite.prepare('SELECT id, refs FROM media ORDER BY id').all()).toEqual([
    { id: 'm1', refs: 2 },
    { id: 'm2', refs: 2 },
    { id: 'm3', refs: 0 },
  ])
})
