import type { AgentTodo } from '@score/contract'
import { useQuery } from '@tanstack/react-query'
import { AgentTodosSchema } from '@score/contract'
import { apiFetch } from '../data/api.ts'

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

export function todoProgress(todos: AgentTodo[]): string {
  const done = todos.filter((todo) => todo.status === 'completed').length
  return `${done} of ${todos.length} done`
}
