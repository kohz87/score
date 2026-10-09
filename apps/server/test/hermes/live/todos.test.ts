import { mkdirSync } from 'node:fs'
import { afterEach, beforeEach, expect, test } from 'vitest'
import { parseTodoResult, readAgentTodos } from '../../../src/hermes/live/todos.ts'
import { createFixtureHome } from '../../fixtures/hermes/sqlite-fixture.ts'

let fixture: ReturnType<typeof createFixtureHome>
beforeEach(() => {
  fixture = createFixtureHome()
  mkdirSync(`${fixture.home}/profiles/builder`, { recursive: true })
})
afterEach(() => fixture.close())

const result = (todos: unknown[], revision = 1) =>
  JSON.stringify({ todos, revision, summary: { total: todos.length } })

function seed() {
  const { db } = fixture.build('state', 'profiles/builder/state.db')
  db.prepare("INSERT INTO sessions (id, source, started_at) VALUES ('s1', 'cli', 1000)").run()
  const add = (role: string, content: string, toolName: string | null, active = 1, ts = 1000) =>
    db
      .prepare(
        'INSERT INTO messages (session_id, role, content, tool_name, timestamp, active) VALUES (?, ?, ?, ?, ?, ?)',
      )
      .run('s1', role, content, toolName, ts, active)
  return add
}

test('the newest todo result wins and malformed items are dropped', () => {
  const add = seed()
  add('tool', result([{ id: 'a', content: 'old', status: 'pending' }], 1), 'todo_list', 1, 1000)
  add(
    'tool',
    result(
      [
        { id: 'a', content: 'write tests', status: 'in_progress' },
        { id: 'b', content: 'ship', status: 'pending', parent: 'a' },
        { id: 'c', content: 'bad status', status: 'nope' },
        'not an object',
      ],
      2,
    ),
    'todo_list',
    1,
    2000,
  )
  add('tool', 'plain output with "todos" in it', 'terminal', 1, 3000)
  expect(readAgentTodos('builder', fixture.home)).toEqual({
    todos: [
      { id: 'a', content: 'write tests', status: 'in_progress' },
      { id: 'b', content: 'ship', status: 'pending', parent: 'a' },
    ],
    revision: 2,
    updatedAt: new Date(2000 * 1000).toISOString(),
  })
})

test('compacted-away rows, other tools and an unknown profile give null; an empty list is a clear', () => {
  const add = seed()
  add('tool', result([{ id: 'a', content: 'x', status: 'pending' }]), 'todo_list', 0)
  add('tool', result([{ id: 'a', content: 'x', status: 'pending' }]), 'web_search', 1)
  expect(readAgentTodos('builder', fixture.home)).toBeNull()
  expect(readAgentTodos('nobody', fixture.home)).toBeNull()
  expect(readAgentTodos('../evil', fixture.home)).toBeNull()
  add('tool', result([], 5), 'todo_list', 1, 5000)
  expect(readAgentTodos('builder', fixture.home)).toMatchObject({ todos: [], revision: 5 })
})

test('parseTodoResult refuses text without the todo result shape', () => {
  expect(parseTodoResult('{"todos": []}')).toBeNull()
  expect(parseTodoResult('{"todos": [], "summary": {}')).toBeNull()
  expect(parseTodoResult('x'.repeat(600_000) + '"todos"')).toBeNull()
})
