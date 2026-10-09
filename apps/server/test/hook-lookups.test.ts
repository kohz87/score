import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { migrate, openDatabase, type ScoreDb } from '../src/db/index.ts'
import { recordToolFrames } from '../src/domain/watch-frames.ts'

let dir: string
let db: ScoreDb
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'score-hooks-'))
  db = openDatabase(join(dir, 'score.db'))
  migrate(db, fileURLToPath(new URL('../migrations/', import.meta.url)))
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

const plan = (sql: string, ...params: string[]) =>
  (db.sqlite.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...params) as { detail: string }[])
    .map((row) => row.detail)
    .join(' | ')

test('hook lookups use indexes instead of scanning the agent history', () => {
  expect(
    plan(
      'SELECT payload FROM watch_frames WHERE agent_id = ? AND surface = \'browser\' AND payload NOT LIKE \'%"url":""%\' ORDER BY seq DESC LIMIT 1',
      'a',
    ),
  ).toContain('watch_frames_browser')
  const runs = plan(
    'SELECT id FROM runs WHERE profile = ? AND session_id = ? ORDER BY started_at DESC LIMIT 1',
    'a',
    's',
  )
  expect(runs).toContain('runs_profile_session')
  expect(runs).not.toContain('TEMP B-TREE')
})

test('terminal hooks do not look up the last browser frame', () => {
  const queries: string[] = []
  const sqlite = db.sqlite
  const prepare = sqlite.prepare.bind(sqlite)
  sqlite.prepare = ((sql: string) => {
    queries.push(sql)
    return prepare(sql)
  }) as typeof sqlite.prepare
  const context = { agentId: 'a', at: '2026-10-08T10:00:00.000Z', sessionId: 's', toolCallId: 'c' }
  recordToolFrames(sqlite, context, {
    hook: 'pre',
    tool: 'terminal',
    args: { command: 'ls' },
    result: undefined,
    status: 'running',
    watch: null,
  })
  expect(queries.some((sql) => sql.includes("surface = 'browser'"))).toBe(false)
  recordToolFrames(
    sqlite,
    { ...context, toolCallId: 'd' },
    { hook: 'post', tool: 'browser_navigate', args: {}, result: {}, status: 'ok', watch: null },
  )
  expect(queries.some((sql) => sql.includes("surface = 'browser'"))).toBe(true)
})
