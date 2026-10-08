import { useContext, useEffect, useRef, type KeyboardEvent } from 'react'
import { useLocation, useNavigate, useParams, useSearchParams } from 'react-router'
import { AgentGlyph } from '../../components/AgentGlyph.tsx'
import { StreamContext, useStreamQuery } from '../../data/query-client.ts'
import { TaskCard } from './TaskCard.tsx'
import { TaskDrawer } from './TaskDrawer.tsx'
import { taskAgentsQuery, taskColumns, taskRoomsQuery, tasksQuery } from './task-queries.ts'
import './tasks.css'

export function TasksPage() {
  const [params, setParams] = useSearchParams()
  const { taskId } = useParams()
  const { search } = useLocation()
  const navigate = useNavigate()
  const context = useContext(StreamContext)
  const filters = {
    agent: params.get('agent') ?? '',
    room: params.get('room') ?? '',
    needsYou: params.get('needsYou') === 'true',
  }
  const definition = tasksQuery(filters)
  const board = useStreamQuery(definition)
  const agents = useStreamQuery(taskAgentsQuery)
  const rooms = useStreamQuery(taskRoomsQuery)
  const cards = useRef(new Map<string, HTMLAnchorElement>())
  const closeDetails = useRef<HTMLAnchorElement>(null)
  const previousTaskId = useRef<string | undefined>(undefined)

  useEffect(() => {
    if (taskId) closeDetails.current?.focus()
    else if (previousTaskId.current) cards.current.get(previousTaskId.current)?.focus()
    previousTaskId.current = taskId
  }, [taskId])

  function setFilter(key: string, value: string) {
    setParams((current) => {
      const next = new URLSearchParams(current)
      if (value) next.set(key, value)
      else next.delete(key)
      return next
    })
  }

  function moveFocus(event: KeyboardEvent<HTMLAnchorElement>, columnIndex: number, row: number) {
    if (
      !board.data ||
      !['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)
    )
      return
    event.preventDefault()
    const columns = board.data.columns
    let nextColumn = columnIndex
    let nextRow = row
    if (event.key === 'ArrowUp') nextRow--
    if (event.key === 'ArrowDown') nextRow++
    if (event.key === 'Home') nextRow = 0
    if (event.key === 'End') nextRow = columns[taskColumns[columnIndex]!.id].length - 1
    if (event.key === 'ArrowLeft' || event.key === 'ArrowRight') {
      const direction = event.key === 'ArrowLeft' ? -1 : 1
      for (
        let index = columnIndex + direction;
        index >= 0 && index < taskColumns.length;
        index += direction
      ) {
        if (columns[taskColumns[index]!.id].length) {
          nextColumn = index
          break
        }
      }
    }
    const items = columns[taskColumns[nextColumn]!.id]
    const task = items[Math.max(0, Math.min(nextRow, items.length - 1))]
    if (task) cards.current.get(task.id)?.focus()
  }

  const allTasks = board.data ? taskColumns.flatMap(({ id }) => board.data!.columns[id]) : []
  const selected = allTasks.find((task) => task.id === taskId)
  return (
    <div className="tasks-page">
      <section className="tasks-heading" aria-label="Tasks and filters">
        <h1>Tasks</h1>
        <div className="tasks-filters" role="group" aria-label="Filter tasks">
          <select
            className={`task-filter task-room-filter${!filters.room ? ' task-filter--selected' : ''}`}
            aria-label="Room"
            value={filters.room}
            onChange={(event) => setFilter('room', event.target.value)}
          >
            <option value="">All rooms</option>
            {filters.room && !rooms.data?.some((room) => room.id === filters.room) && (
              <option value={filters.room}>{filters.room}</option>
            )}
            {rooms.data?.map((room) => (
              <option key={room.id} value={room.id}>
                {room.name}
              </option>
            ))}
          </select>
          <button
            type="button"
            className={`task-filter${filters.needsYou ? ' task-filter--selected' : ''}`}
            aria-pressed={filters.needsYou}
            onClick={() => setFilter('needsYou', filters.needsYou ? '' : 'true')}
          >
            Needs you
          </button>
          {agents.data?.map((agent) => (
            <button
              key={agent.id}
              type="button"
              className={`task-filter task-agent-filter${filters.agent === agent.id ? ' task-filter--selected' : ''}`}
              aria-pressed={filters.agent === agent.id}
              onClick={() => setFilter('agent', filters.agent === agent.id ? '' : agent.id)}
            >
              <AgentGlyph agent={agent} size="sm" decorative />
              {agent.name}
            </button>
          ))}
          {filters.agent && !agents.data?.some((agent) => agent.id === filters.agent) && (
            <button
              type="button"
              className="task-filter task-filter--selected"
              onClick={() => setFilter('agent', '')}
            >
              Clear agent filter: {filters.agent}
            </button>
          )}
          <button type="button" className="tasks-new" disabled title="Task creation is coming soon">
            New task
          </button>
        </div>
      </section>
      {agents.status === 'error' && (
        <p role="alert">
          Agent details could not load.{' '}
          <button
            type="button"
            onClick={() => void context?.queries.register(taskAgentsQuery).refetch()}
          >
            Retry agents
          </button>
        </p>
      )}
      {rooms.status === 'error' && (
        <p role="alert">
          Rooms could not load.{' '}
          <button
            type="button"
            onClick={() => void context?.queries.register(taskRoomsQuery).refetch()}
          >
            Retry rooms
          </button>
        </p>
      )}
      <div className="tasks-layout">
        <div className="tasks-board-area">
          {board.status === 'pending' && (
            <p role="status">{board.data ? 'Refreshing tasks…' : 'Loading tasks…'}</p>
          )}
          {board.status === 'error' && (
            <div className="tasks-message" role="alert">
              <p>Tasks could not load. Please try again.</p>
              <button
                type="button"
                className="task-filter"
                onClick={() => void context?.queries.register(definition).refetch()}
              >
                Retry tasks
              </button>
            </div>
          )}
          {board.data && allTasks.length === 0 && (
            <p className="tasks-empty" role="status">
              {filters.agent || filters.room || filters.needsYou
                ? 'No tasks match these filters.'
                : 'No tasks yet.'}
            </p>
          )}
          <p className="tasks-sr-only" aria-live="polite" aria-atomic="true">
            {board.data?.announcement}
          </p>
          <div className="tasks-board-scroll" role="region" aria-label="Tasks board" tabIndex={0}>
            <div className="tasks-board">
              {taskColumns.map(({ id, label }, columnIndex) => (
                <section key={id} className="task-column" aria-label={label}>
                  <div className="task-column-heading">
                    <h2>{label}</h2>
                    <span aria-label={`${board.data?.columns[id].length ?? 0} tasks`}>
                      {board.data?.columns[id].length ?? 0}
                    </span>
                  </div>
                  {board.data?.columns[id].map((task, row) => (
                    <TaskCard
                      key={task.id}
                      task={task}
                      agents={agents.data ?? []}
                      roomName={rooms.data?.find((room) => room.id === task.roomId)?.name}
                      selected={taskId === task.id}
                      to={`/tasks/${encodeURIComponent(task.id)}${search}`}
                      cardRef={(element) => {
                        if (element) cards.current.set(task.id, element)
                        else cards.current.delete(task.id)
                      }}
                      onKeyDown={(event) => moveFocus(event, columnIndex, row)}
                    />
                  ))}
                  {board.status === 'success' && board.data?.columns[id].length === 0 && (
                    <p className="task-column-empty">No tasks</p>
                  )}
                </section>
              ))}
            </div>
          </div>
        </div>
        {taskId && (
          <TaskDrawer
            key={taskId}
            taskId={taskId}
            summary={selected}
            agents={agents.data ?? []}
            rooms={rooms.data ?? []}
            closeTo={`/tasks${search}`}
            closeRef={closeDetails}
            onKeyDown={(event) => {
              if (event.key === 'Escape') {
                event.preventDefault()
                void navigate(`/tasks${search}`)
              }
            }}
          />
        )}
      </div>
    </div>
  )
}
