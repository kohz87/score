import type { AgentTodo } from '@score/contract'
import { useQuery } from '@tanstack/react-query'
import { AgentTodosSchema } from '@score/contract'
import { apiFetch } from '../data/api.ts'

const LABEL: Record<AgentTodo['status'], string> = {
  pending: 'To do',
  in_progress: 'In progress',
  completed: 'Done',
  cancelled: 'Cancelled',
}
const MARK: Record<AgentTodo['status'], string> = {
  pending: '○',
  in_progress: '◐',
  completed: '●',
  cancelled: '✕',
}

/** The agent's Hermes todo list (read-only). `live` polls faster while the agent is working. */
export function useAgentTodos(agentId: string, live: boolean) {
  return useQuery({
    queryKey: ['agents', agentId, 'todos'] as const,
    queryFn: async ({ signal }) =>
      AgentTodosSchema.parse(
        await apiFetch(`agents/${encodeURIComponent(agentId)}/todos`, { signal }),
      ),
    refetchInterval: live ? 4000 : 30_000,
    refetchOnWindowFocus: true,
    retry: false,
  })
}

/** Items with their state in words as well as a mark (never colour alone); subtasks are indented. */
export function TodoItems({ todos }: { todos: AgentTodo[] }) {
  const ids = new Set(todos.map((todo) => todo.id))
  return (
    <ul className="todo-list">
      {todos.map((todo) => (
        <li
          key={todo.id}
          className={`todo-item todo-${todo.status}${todo.parent && ids.has(todo.parent) ? ' todo-sub' : ''}`}
        >
          <span className="todo-mark" aria-hidden="true">
            {MARK[todo.status]}
          </span>
          <span className="todo-text">{todo.content}</span>
          <span className="todo-state">{LABEL[todo.status]}</span>
        </li>
      ))}
    </ul>
  )
}

export function todoProgress(todos: AgentTodo[]): string {
  const done = todos.filter((todo) => todo.status === 'completed').length
  return `${done} of ${todos.length} done`
}
