import type { AgentDetail } from '@score/contract'
import { todoProgress, useAgentTodos } from '../../components/TodoList.tsx'
import { TodoCard } from '../agent-more/TodoCard.tsx'
import { OpenCard, useOpenState } from './OpenCard.tsx'

/** Todo (mock-up 26): one line of progress and the item in hand; the list opens in place when there is one. */
export function TodoTile({ agent, initialOpen }: { agent: AgentDetail; initialOpen: boolean }) {
  const todos = useAgentTodos(agent.id, agent.status === 'working')
  const [open, setOpen] = useOpenState(initialOpen)
  const items = todos.data?.todos ?? []
  const current = items.find((todo) => todo.status === 'in_progress')
  return (
    <OpenCard
      open={open}
      onOpen={() => setOpen(true)}
      onClose={() => setOpen(false)}
      title="Todo"
      summary={
        todos.isPending
          ? 'Loading todo…'
          : todos.isError
            ? 'Couldn’t load the todo list.'
            : items.length
              ? [todoProgress(items), current?.content].filter(Boolean).join(' · ')
              : 'Nothing on its todo list.'
      }
      openLabel={items.length ? 'Open todo list' : undefined}
      openName="Open todo list"
    >
      <TodoCard agent={agent} />
    </OpenCard>
  )
}
