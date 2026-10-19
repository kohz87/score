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
  dir = mkdtempSync(join(tmpdir(), 'score-looks-mig-'))
  db = openDatabase(join(dir, 'score.db'))
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

// PLAN 10.2a: 0078 rebuilds agent_styles (20 shapes, look, avatar_rev) and gives coding_agents look + avatar_rev.
function migrateBefore() {
  const migrations = join(dir, 'migrations')
  mkdirSync(migrations)
  for (const name of readdirSync(SRC).filter((file) => file.endsWith('.sql')))
    if (name < '0078') copyFileSync(join(SRC, name), join(migrations, name))
  migrate(db, migrations)
  return migrations
}
const at = '2026-10-19T00:00:00.000Z'
const addCoding = (id: string, color: string, shape: string) =>
  db.sqlite
    .prepare(
      `INSERT INTO coding_agents (id, name, runtime, workspace, permission, color, shape, created_at)
       VALUES (?, ?, 'codex', '/tmp/w', 'read-only', ?, ?, ?)`,
    )
    .run(id, id, color, shape, at)
function upgrade(migrations: string) {
  copyFileSync(join(SRC, '0078_agent_looks.sql'), join(migrations, '0078_agent_looks.sql'))
  migrate(db, migrations)
}

test('0078 keeps every stored style and gives it the default look and no picture', () => {
  const migrations = migrateBefore()
  const insert = db.sqlite.prepare(
    'INSERT INTO agent_styles (agent_id, color, shape, updated_at) VALUES (?, ?, ?, ?)',
  )
  insert.run('lead', '#6B4EFF', 'hexagon', at)
  insert.run('builder', '#19C39A', 'cross', at)
  upgrade(migrations)
  expect(db.sqlite.prepare('SELECT * FROM agent_styles ORDER BY agent_id').all()).toEqual([
    {
      agent_id: 'builder',
      color: '#19C39A',
      shape: 'cross',
      look: 'bot',
      avatar_rev: null,
      updated_at: at,
    },
    {
      agent_id: 'lead',
      color: '#6B4EFF',
      shape: 'hexagon',
      look: 'bot',
      avatar_rev: null,
      updated_at: at,
    },
  ])
})

test('0078 accepts all 20 shapes and refuses an unknown shape or look', () => {
  upgrade(migrateBefore())
  const insert = db.sqlite.prepare(
    'INSERT INTO agent_styles (agent_id, color, shape, look, updated_at) VALUES (?, ?, ?, ?, ?)',
  )
  for (const shape of ShapeSchema.options) insert.run(`a-${shape}`, '#112233', shape, 'chibi', at)
  expect(db.sqlite.prepare('SELECT count(*) AS n FROM agent_styles').get()).toEqual({
    n: ShapeSchema.options.length,
  })
  expect(ShapeSchema.options).toHaveLength(20)
  expect(() => insert.run('x', '#112233', 'dodecagon', 'bot', at)).toThrow()
  expect(() => insert.run('y', '#112233', 'cloud', 'robot', at)).toThrow()
})

test('0078 gives coding agents look and avatar_rev, and a style override moves into the agent row', () => {
  const migrations = migrateBefore()
  addCoding('coder', '#111111', 'square')
  addCoding('other', '#222222', 'star')
  db.sqlite
    .prepare('INSERT INTO agent_styles (agent_id, color, shape, updated_at) VALUES (?, ?, ?, ?)')
    .run('coder', '#abcdef', 'pill', at)
  upgrade(migrations)
  expect(
    db.sqlite
      .prepare('SELECT id, color, shape, look, avatar_rev FROM coding_agents ORDER BY id')
      .all(),
  ).toEqual([
    { id: 'coder', color: '#abcdef', shape: 'pill', look: 'bot', avatar_rev: null },
    { id: 'other', color: '#222222', shape: 'star', look: 'bot', avatar_rev: null },
  ])
  // Coding agents are styled in one place only.
  expect(
    db.sqlite.prepare("SELECT agent_id FROM agent_styles WHERE agent_id = 'coder'").all(),
  ).toEqual([])
  expect(() =>
    db.sqlite.prepare("UPDATE coding_agents SET look = 'robot' WHERE id = 'coder'").run(),
  ).toThrow()
})
