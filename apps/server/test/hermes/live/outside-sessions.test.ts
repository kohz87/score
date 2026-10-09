import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, statSync } from 'node:fs'
import { afterEach, beforeEach, expect, test } from 'vitest'
import {
  listOutsideSessions,
  readOutsideSession,
} from '../../../src/hermes/live/outside-sessions.ts'
import { createFixtureHome } from '../../fixtures/hermes/sqlite-fixture.ts'

let fixture: ReturnType<typeof createFixtureHome>
let db: ReturnType<typeof fixture.build>['db']
const NOW = 1_800_000_000_000
const sec = NOW / 1000

beforeEach(() => {
  fixture = createFixtureHome()
  db = fixture.build('state').db
})
afterEach(() => fixture.close())

function session(
  id: string,
  patch: {
    source?: string
    title?: string | null
    startedAt?: number
    endedAt?: number | null
    count?: number
    last?: number | null
    parent?: string | null
  } = {},
) {
  db.prepare(
    `INSERT INTO sessions (id, source, title, started_at, ended_at, message_count, last_activity_at, parent_session_id)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  ).run(
    id,
    patch.source ?? 'telegram',
    patch.title === undefined ? null : patch.title,
    patch.startedAt ?? sec - 3600,
    patch.endedAt === undefined ? sec - 1800 : patch.endedAt,
    patch.count ?? 2,
    patch.last === undefined ? sec - 1800 : patch.last,
    patch.parent ?? null,
  )
}
function say(id: string, role: string, content: string | null, at: number) {
  db.prepare('INSERT INTO messages (session_id, role, content, timestamp) VALUES (?, ?, ?, ?)').run(
    id,
    role,
    content,
    at,
  )
}
const fingerprint = (path: string) =>
  `${statSync(path).size}:${createHash('sha256').update(readFileSync(path)).digest('hex')}`

test('lists conversations, not automation, Score runs, children or empty sessions', () => {
  session('tg', { title: 'Launch plan' })
  session('cli', { source: 'cli', title: null, startedAt: sec - 100 })
  say('cli', 'system', 'You are an agent', sec - 99)
  say('cli', 'user', 'Why is   the build\n slow? api_key=sk-abcdefghijklmnop123', sec - 98)
  session('cron-job', { source: 'cron' })
  session('kanban-run', { source: 'kanban' })
  session('sub', { source: 'subagent' })
  session('score-room-agent', { source: 'api_server' })
  session('other-api', { source: 'api_server', title: 'Some other API client' })
  session('compressed-child', { parent: 'tg' })
  session('empty', { count: 0 })
  const { items, unavailable } = listOutsideSessions(['default'], fixture.home, NOW)
  expect(unavailable).toEqual([])
  // Newest first.
  expect(items[0]!.id).toBe('cli')
  const byId = Object.fromEntries(items.map((item) => [item.id, item]))
  expect(Object.keys(byId).sort()).toEqual(['cli', 'other-api', 'tg'])
  expect(byId.tg).toMatchObject({
    agentId: 'default',
    source: 'telegram',
    sourceLabel: 'Telegram',
    title: 'Launch plan',
    messageCount: 2,
    busy: false,
    startedAt: new Date((sec - 3600) * 1000).toISOString(),
  })
  // No title: the first user message, flattened and redacted.
  expect(byId.cli!.title).toBe('Why is the build slow? api_key=[redacted]')
  expect(byId.cli!.sourceLabel).toBe('CLI')
})

test('a session that is not ended and was active a minute ago is busy', () => {
  session('live', { endedAt: null, last: sec - 60 })
  session('idle-open', { endedAt: null, last: sec - 3600 })
  session('just-ended', { endedAt: sec - 10, last: sec - 10 })
  const items = Object.fromEntries(
    listOutsideSessions(['default'], fixture.home, NOW).items.map((item) => [item.id, item.busy]),
  )
  expect(items).toEqual({ live: true, 'idle-open': false, 'just-ended': false })
})

test('reads user and assistant text only, in order, redacted, never modifying the database', () => {
  session('tg', { title: 'Plan', count: 5 })
  say('tg', 'user', 'First question', sec - 3000)
  say('tg', 'assistant', null, sec - 2990)
  say('tg', 'tool', '{"result":"hidden tool output"}', sec - 2980)
  say('tg', 'assistant', 'Answer with token=abcdefghijklmnopqrstuvwxyz0123456789', sec - 2970)
  say('tg', 'system', 'system prompt text', sec - 2960)
  say('tg', 'user', '   ', sec - 2950)
  const history = readOutsideSession('default', 'tg', fixture.home, NOW)!
  expect(history.session).toMatchObject({ id: 'tg', title: 'Plan', sourceLabel: 'Telegram' })
  expect(history.messages).toEqual([
    { role: 'user', text: 'First question', at: new Date((sec - 3000) * 1000).toISOString() },
    {
      role: 'assistant',
      text: 'Answer with token=[redacted]',
      at: new Date((sec - 2970) * 1000).toISOString(),
    },
  ])
  expect(JSON.stringify(history)).not.toContain('hidden tool output')
  expect(JSON.stringify(history)).not.toContain('system prompt')
  db.exec('PRAGMA wal_checkpoint(TRUNCATE)')
  // Read-only: a read leaves the file exactly as it was.
  const first = fingerprint(`${fixture.home}/state.db`)
  readOutsideSession('default', 'tg', fixture.home, NOW)
  listOutsideSessions(['default'], fixture.home, NOW)
  expect(fingerprint(`${fixture.home}/state.db`)).toBe(first)
})

// audit4-c 5: undone and display-only rows stay out, and a long session keeps its newest end.
test('an import skips undone and display-only rows and keeps the newest messages of a long session', () => {
  session('long', { title: 'Long', count: 1100 })
  say('long', 'user', 'undone question', sec - 5000)
  db.prepare("UPDATE messages SET active = 0 WHERE content = 'undone question'").run()
  say('long', 'assistant', 'display only note', sec - 4990)
  db.prepare("UPDATE messages SET display_kind = 'note' WHERE content = 'display only note'").run()
  db.exec('BEGIN')
  for (let i = 0; i < 1005; i++)
    say('long', i % 2 === 0 ? 'user' : 'assistant', `line ${i}`, sec - 4000 + i)
  db.exec('COMMIT')
  const history = readOutsideSession('default', 'long', fixture.home, NOW)!
  const texts = history.messages.map((message) => message.text)
  expect(texts).toHaveLength(1000)
  expect(texts[0]).toBe('line 5')
  expect(texts.at(-1)).toBe('line 1004')
  expect(texts).not.toContain('undone question')
  expect(texts).not.toContain('display only note')
})

test('unknown, automation and Score-made sessions are not readable', () => {
  session('cron-job', { source: 'cron' })
  session('score-x-y', { source: 'api_server' })
  expect(readOutsideSession('default', 'nope', fixture.home, NOW)).toBeNull()
  expect(readOutsideSession('default', 'cron-job', fixture.home, NOW)).toBeNull()
  expect(readOutsideSession('default', 'score-x-y', fixture.home, NOW)).toBeNull()
  expect(readOutsideSession('../evil', 'tg', fixture.home, NOW)).toBeNull()
})

test('a profile without a database, a changed schema or a bad name is unavailable or skipped', () => {
  mkdirSync(`${fixture.home}/profiles/builder`, { recursive: true })
  const broken = fixture.build('state', 'profiles/designer.db')
  broken.db.close()
  const drift = fixture.build('state', 'profiles/reviewer-state.db')
  drift.db.close()
  const result = listOutsideSessions(['builder', 'default', '../evil'], fixture.home, NOW)
  expect(result.unavailable).toEqual(['builder'])
  expect(result.items).toEqual([])
  expect(readOutsideSession('builder', 'x', fixture.home, NOW)).toBeNull()
})

test('a state.db without the expected columns marks the profile unavailable', () => {
  db.exec('DROP TABLE messages')
  db.exec('DROP TABLE sessions')
  db.exec('CREATE TABLE sessions (id TEXT PRIMARY KEY)')
  expect(listOutsideSessions(['default'], fixture.home, NOW).unavailable).toEqual(['default'])
})

test('a compressed conversation imports its continuation and is busy while the child is active', () => {
  session('root', { endedAt: sec - 600, last: sec - 600, count: 2 })
  db.prepare("UPDATE sessions SET end_reason = 'compression' WHERE id = 'root'").run()
  say('root', 'user', 'first question', sec - 1000)
  say('root', 'assistant', 'first answer', sec - 990)
  session('child', { parent: 'root', endedAt: null, last: sec - 10, count: 3 })
  say('child', 'user', 'first question', sec - 500) // carried over by compression
  say('child', 'assistant', 'later answer', sec - 20)
  const listed = listOutsideSessions(['default'], fixture.home, NOW).items
  expect(listed.map((item) => [item.id, item.busy])).toEqual([['root', true]])
  const history = readOutsideSession('default', 'root', fixture.home, NOW)!
  expect(history.session.busy).toBe(true)
  expect(history.messages.map((m) => m.text)).toEqual([
    'first question',
    'first answer',
    'later answer',
  ])
})
