import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { migrate, openDatabase, type ScoreDb } from '../../src/db/index.ts'
import { MCP_POSTS_PER_HOUR } from '@score/contract'
import { McpAccessStore } from '../../src/mcp/access.ts'
import { pruneAuxiliary } from '../../src/hub/retention-aux.ts'

let dir: string
let db: ScoreDb
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'score-retention-aux-'))
  db = openDatabase(join(dir, 'score.db'))
  migrate(db, fileURLToPath(new URL('../../migrations/', import.meta.url)))
})
afterEach(() => {
  db.close()
  rmSync(dir, { recursive: true, force: true })
})

// audit4-c 8: run_thinking and knowledge_agent_writes had no retention.
test('the hourly pass drops old reasoning text and stale knowledge write rows only', () => {
  const now = Date.parse('2026-10-09T12:00:00.000Z')
  const run = db.sqlite.prepare(
    `INSERT INTO runs (id, profile, origin, status, started_at, updated_at) VALUES (?, 'lead', 'score', 'completed', ?, ?)`,
  )
  run.run('old', '2026-09-01T00:00:00.000Z', '2026-09-01T00:00:00.000Z')
  run.run('new', '2026-10-08T00:00:00.000Z', '2026-10-08T00:00:00.000Z')
  const think = db.sqlite.prepare('INSERT INTO run_thinking (run_id, seq, text) VALUES (?, 1, ?)')
  think.run('old', 'ancient thoughts')
  think.run('new', 'fresh thoughts')
  const write = db.sqlite.prepare('INSERT INTO knowledge_agent_writes (agent_id, at) VALUES (?, ?)')
  write.run('lead', now - 25 * 3_600_000)
  write.run('lead', now - 3_600_000)
  expect(pruneAuxiliary(db, { now })).toEqual({ thinking: 1, knowledgeWrites: 1, mcpPosts: 0 })
  expect(db.sqlite.prepare('SELECT run_id FROM run_thinking').all()).toEqual([{ run_id: 'new' }])
  expect(db.sqlite.prepare('SELECT COUNT(*) AS n FROM knowledge_agent_writes').get()?.n).toBe(1)
  // The run itself stays.
  expect(db.sqlite.prepare('SELECT COUNT(*) AS n FROM runs').get()?.n).toBe(2)
})

test('fix-argon A3: the hourly pass drops mcp_posts outside the rate window and keeps the counted ones', () => {
  const now = Date.parse('2026-10-09T12:00:00.000Z')
  const store = new McpAccessStore(db, () => now)
  const post = db.sqlite.prepare('INSERT INTO mcp_posts (agent_id, tool, at) VALUES (?, ?, ?)')
  post.run('lead', 'rooms.post', now - 3 * 86_400_000)
  post.run('lead', 'rooms.post', now - 10 * 86_400_000)
  for (let i = 0; i < MCP_POSTS_PER_HOUR - 1; i++) post.run('lead', 'rooms.post', now - 60_000 - i)
  expect(pruneAuxiliary(db, { now }).mcpPosts).toBe(2)
  expect(db.sqlite.prepare('SELECT COUNT(*) AS n FROM mcp_posts').get()?.n).toBe(
    MCP_POSTS_PER_HOUR - 1,
  )
  // The limit still counts correctly: one more post fits, the next is refused.
  store.reservePost('lead', 'rooms.post')
  expect(() => store.reservePost('lead', 'rooms.post')).toThrow(/Too many posts/)
})
