import { copyFileSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { ShapeSchema } from '@score/contract'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { migrate, openDatabase, type ScoreDb } from '../src/db/index.ts'

const SRC = fileURLToPath(new URL('../migrations/', import.meta.url))
let dir: string
let db: ScoreDb
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'score-shapes-mig-'))
  db = openDatabase(join(dir, 'score.db'))
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const at = '2026-10-26T00:00:00.000Z'

// 2.2.0: 0088 rebuilds agent_styles with ball and flower; every stored row and column survives.
test('0088 keeps every stored style and accepts every contract shape', () => {
  const migrations = join(dir, 'migrations')
  mkdirSync(migrations)
  for (const name of readdirSync(SRC).filter((file) => file.endsWith('.sql')))
    if (name < '0088') copyFileSync(join(SRC, name), join(migrations, name))
  migrate(db, migrations)
  db.sqlite
    .prepare(
      `INSERT INTO agent_styles (agent_id, color, shape, look, updated_at) VALUES ('lead', '#6B4EFF', 'gem', 'ring', ?)`,
    )
    .run(at)
  expect(() =>
    db.sqlite
      .prepare(
        `INSERT INTO agent_styles (agent_id, color, shape, updated_at) VALUES ('x', '#000000', 'ball', ?)`,
      )
      .run(at),
  ).toThrow()

  copyFileSync(
    join(SRC, '0088_ball_flower_shapes.sql'),
    join(migrations, '0088_ball_flower_shapes.sql'),
  )
  migrate(db, migrations)

  expect(
    db.sqlite.prepare('SELECT agent_id, color, shape, look, updated_at FROM agent_styles').all(),
  ).toEqual([{ agent_id: 'lead', color: '#6B4EFF', shape: 'gem', look: 'ring', updated_at: at }])
  const insert = db.sqlite.prepare(
    'INSERT INTO agent_styles (agent_id, color, shape, updated_at) VALUES (?, ?, ?, ?)',
  )
  for (const shape of ShapeSchema.options) insert.run(`a-${shape}`, '#123456', shape, at)
  expect(() => insert.run('bad', '#123456', 'spiral', at)).toThrow()
})
