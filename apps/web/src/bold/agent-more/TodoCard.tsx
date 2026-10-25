import type { AgentDetail } from '@score/contract'
import { todoProgress, useAgentTodos } from '../../components/TodoList.tsx'
import { Fail, Loading, MoreCard } from './MoreCard.tsx'

const state = {
  pending: 'To do',
  in_progress: 'In progress',
  completed: 'Done',
  cancelled: 'Cancelled',
} as const

export function TodoCard({ agent }: { agent: AgentDetail }) {
  const todos = useAgentTodos(agent.id, agent.status === 'working')
  const items = todos.data?.todos ?? []
  return (
    <MoreCard id="agent-todo" title="Todo" count={items.length ? todoProgress(items) : undefined}>
      {todos.isPending && <Loading what="todo" />}
      {todos.isError && <Fail>Couldn’t load the todo list.</Fail>}
      {todos.isSuccess && !items.length && <p className="small muted">Nothing on its todo list.</p>}
      {items.map((todo) => (
        <div className="listrow" key={todo.id}>
          <span className="grow small">{todo.content}</span>
          <span className="small muted">{state[todo.status]}</span>
        </div>
      ))}
    </MoreCard>
  )
}
