import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { DatabaseSync } from 'node:sqlite'

export function buildFixture(path: string, kind: 'kanban' | 'state'): DatabaseSync {
  const db = new DatabaseSync(path)
  try {
    const schema = readFileSync(new URL(`./${kind}-schema.sql`, import.meta.url), 'utf8')
    // The recorded dumps start with a shell-style summary, not a SQL comment.
    const sql = schema.replace(/^#.*$/gm, '')
    // sqlite_master dumps place triggers before the tables they depend on.
    const triggers = [...sql.matchAll(/CREATE TRIGGER[\s\S]*?\nEND;/g)].map(([trigger]) => trigger)
    db.exec(sql.replace(/CREATE TRIGGER[\s\S]*?\nEND;/g, ''))
    for (const trigger of triggers) db.exec(trigger)
    db.exec('PRAGMA journal_mode = WAL')
    return db
  } catch (error) {
    db.close()
    throw error
  }
}

export function createFixtureHome() {
  const home = mkdtempSync(join(tmpdir(), 'score-readers-'))
  const connections: DatabaseSync[] = []
  return {
    home,
    build(kind: 'kanban' | 'state', filename = `${kind}.db`) {
      const path = join(home, filename)
      const db = buildFixture(path, kind)
      connections.push(db)
      return { path, db }
    },
    close() {
      for (const db of connections) {
        if (db.isOpen) db.close()
      }
      rmSync(home, { recursive: true, force: true })
    },
  }
}

export function insertTask(db: DatabaseSync, id = 'task-1'): void {
  db.prepare(
    `INSERT INTO tasks (id, title, body, assignee, status, created_by, created_at)
     VALUES (?, 'Build example feature', 'Generic task body', 'builder', 'todo', 'lead', 2000)`,
  ).run(id)
}

export function insertSession(db: DatabaseSync, id = 'session-1'): void {
  db.prepare(
    `INSERT INTO sessions (id, source, profile_name, model, started_at)
     VALUES (?, 'cli', 'builder', 'example-model', 2000)`,
  ).run(id)
}

export function insertEvent(
  db: DatabaseSync,
  timestamp = 2000,
  payload: string | null = null,
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO task_events (task_id, kind, payload, created_at)
       VALUES ('task-1', 'created', ?, ?)`,
      )
      .run(payload, timestamp).lastInsertRowid,
  )
}

export function insertMessage(
  db: DatabaseSync,
  timestamp = 2000,
  toolCalls: string | null = null,
): number {
  return Number(
    db
      .prepare(
        `INSERT INTO messages (session_id, role, content, timestamp, tool_calls, message_uid)
       VALUES ('session-1', 'assistant', 'Example reply', ?, ?, ?)`,
      )
      .run(timestamp, toolCalls, `message-${timestamp}`).lastInsertRowid,
  )
}
