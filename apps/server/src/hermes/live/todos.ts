import { AgentTodoSchema, type AgentTodo, type AgentTodos } from '@score/contract'
import { z } from 'zod'
import { hermesPaths, ProfileNameSchema } from './paths.ts'
import { HermesDbMissing, openReadOnly } from './sqlite.ts'

// Hermes keeps an agent's todo list in memory (tools/todo_tool.py) but every `todo_list` call is also a tool result in
// the conversation history, and Hermes itself rebuilds the list from the newest such result (AIAgent._hydrate_todo_store).
// So the newest tool message carrying `{ todos, revision, summary }` in the profile's state.db is the current list.
const MAX_RESULT_CHARS = 512_000
const CANDIDATES = 8

const RowSchema = z.object({
  content: z.string().nullable(),
  tool_name: z.string().nullable(),
  timestamp: z.number(),
})
const ResultSchema = z.object({
  todos: z.array(z.unknown()),
  revision: z.number().optional(),
  summary: z.object({}).passthrough(),
})

/** Pure: picks the list out of one tool result's text, dropping malformed items. Null when it is not a todo result. */
export function parseTodoResult(content: string): { todos: AgentTodo[]; revision: number } | null {
  if (content.length > MAX_RESULT_CHARS || !content.includes('"todos"')) return null
  let data: unknown
  try {
    data = JSON.parse(content)
  } catch {
    return null
  }
  const parsed = ResultSchema.safeParse(data)
  if (!parsed.success) return null
  const todos = parsed.data.todos
    .map((item) => AgentTodoSchema.safeParse(item))
    .flatMap((item) => (item.success ? [item.data] : []))
    .slice(0, 200)
  const revision = Math.max(0, Math.trunc(parsed.data.revision ?? 0))
  return { todos, revision }
}

/** The agent's latest todo list, read-only from its profile state.db; null when it never wrote one or the db is missing. */
export function readAgentTodos(agentId: string, hermesHome: string): AgentTodos {
  if (!ProfileNameSchema.safeParse(agentId).success) return null
  let db
  try {
    db = openReadOnly(hermesPaths(hermesHome).stateDb(agentId))
  } catch (error) {
    if (error instanceof HermesDbMissing) return null
    throw error
  }
  try {
    const rows = db
      .prepare(
        `SELECT content, tool_name, timestamp FROM messages
         WHERE role = 'tool' AND active = 1 AND content LIKE '%"todos"%'
           AND (tool_name IS NULL OR tool_name IN ('todo_list', 'todo'))
         ORDER BY id DESC LIMIT ?`,
      )
      .all(CANDIDATES)
    for (const raw of rows) {
      const row = RowSchema.safeParse(raw)
      if (!row.success || row.data.content === null) continue
      const result = parseTodoResult(row.data.content)
      if (result)
        return {
          ...result,
          updatedAt: new Date(row.data.timestamp * 1000).toISOString(),
        }
    }
    return null
  } catch (error) {
    // A Hermes upgrade that renames a column must not break the Team page: the card just stays hidden.
    if (error instanceof Error && /no such (table|column)/i.test(error.message)) return null
    throw error
  } finally {
    db.close()
  }
}
