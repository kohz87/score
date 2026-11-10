import type { TaskColumn } from '@score/contract'
import { useMemo, useState } from 'react'
import { useStreamQuery } from '../data/query-client.ts'
import { useMediaQuery } from '../data/use-media.ts'
import { agentsQuery, roomsQuery } from '../routes/chat/queries.ts'
import { agentDisplayName, onTeam } from './bold-agents.ts'
import {
  BOARD_COLUMNS,
  boardColumn,
  filterTasks,
  groupTasks,
  roomChoices,
} from './bold-tasks-model.ts'
import { allTasksQuery } from './room/task-queries.ts'
import { NewTaskDialog } from './BoldTaskEdit.tsx'
import { Column } from './BoldTasksCards.tsx'
import { Chips } from './BoldTasksFilters.tsx'
import { PhoneNeedsCard } from './BoldTasksNeeds.tsx'
import { TaskPanel } from './BoldTasksPanel.tsx'
import { Sheet } from './BoldTasksSheet.tsx'
import { TasksTabs } from './tasks-tabs/TasksTabs.tsx'
import { roomName, type Lookup } from './bold-tasks-page-model.ts'
import './bold-tasks.css'

// 3.16.0: the Tasks board, back in the new shell (the Kanban board went in 11.11). Every Hermes task across rooms in
// columns. Agents move their own tasks, so there is no drag; the person acts on what needs them (unblock, an approval,
// a comment). 3.27.0 adds New task, Edit, the moves and Archive (BoldTaskEdit.tsx). Mock-up: docs/design/bold/mockups/13-tasks-board*.dc.html.

const PHONE = '(max-width: 600px)'
// The details panel sits beside the board from here; below it the panel opens as a side sheet.
const WIDE = '(min-width: 1280px)'
const PHONE_TABS: TaskColumn[] = ['working', 'planned', 'in_review', 'done']

export function BoldTasksPage() {
  const phone = useMediaQuery(PHONE)
  const wide = useMediaQuery(WIDE)
  const tasksState = useStreamQuery(allTasksQuery)
  const agentsState = useStreamQuery(agentsQuery)
  const roomsState = useStreamQuery(roomsQuery)
  const agents = useMemo(() => (agentsState.data ?? []).filter(onTeam), [agentsState.data])
  const rooms = useMemo(() => roomsState.data?.rooms ?? [], [roomsState.data])
  const lookup = useMemo<Lookup>(() => ({ agents, rooms }), [agents, rooms])
  // An archived task leaves the board at once; the stream and the refetch then agree.
  const [archivedIds, setArchivedIds] = useState<string[]>([])
  const [making, setMaking] = useState(false)
  const [createdNote, setCreatedNote] = useState<string | null>(null)
  const all = useMemo(
    () =>
      (tasksState.data?.tasks ?? []).filter(
        (task) => task.hermesStatus !== 'archived' && !archivedIds.includes(task.id),
      ),
    [tasksState.data, archivedIds],
  )
  const [agentFilter, setAgentFilter] = useState<string | null>(null)
  const [roomFilter, setRoomFilter] = useState<string | null>(null)
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [phoneTab, setPhoneTab] = useState<TaskColumn>('working')

  const roomIds = useMemo(() => roomChoices(all), [all])
  const activeRoom = roomFilter !== null && roomIds.includes(roomFilter) ? roomFilter : null
  const visible = useMemo(
    () => filterTasks(all, { agent: agentFilter, room: activeRoom }),
    [all, agentFilter, activeRoom],
  )
  const grouped = useMemo(() => groupTasks(visible), [visible])
  const needsCount = useMemo(
    () => all.filter((task) => boardColumn(task) === 'needs_you').length,
    [all],
  )
  const filtered = agentFilter !== null || activeRoom !== null
  const selected = selectedId ? (all.find((task) => task.id === selectedId) ?? null) : null

  const archived = () => {
    if (selectedId) setArchivedIds((ids) => [...ids, selectedId])
    setSelectedId(null)
  }

  const status = tasksState.status
  const loading = status === 'pending' && !tasksState.data
  const failed = status === 'error' && !tasksState.data
  const none = !loading && !failed && all.length === 0

  const agentOptions = [
    { id: null, label: 'Everyone' },
    ...agents.map((agent) => ({ id: agent.id, label: agentDisplayName(agent), agent })),
  ]
  const roomOptions = [
    { id: null, label: 'All rooms' },
    ...roomIds.map((id) => ({ id, label: roomName(lookup, id) })),
  ]

  return (
    <div className="bold-page bold-tb" data-ui-page="tasks">
      <header className="bold-tb-head">
        <div className="bold-tb-title">
          <div className="bold-tb-h1row">
            <h1>Tasks</h1>
            <button type="button" className="bold-tb-new" onClick={() => setMaking(true)}>
              <svg width="12" height="12" viewBox="0 0 12 12" aria-hidden="true">
                <path
                  d="M6 1.5v9M1.5 6h9"
                  stroke="currentColor"
                  strokeWidth="1.8"
                  strokeLinecap="round"
                />
              </svg>
              <span>New task</span>
            </button>
          </div>
          <p>
            Every Hermes task across your chats. Agents move their own; you can add, change, move or
            archive any of them.
          </p>
        </div>
        {/* Decision 183: the Tasks views end the header on every Tasks page; what needs you sits before them. */}
        <div className="bold-tb-side">
          {needsCount > 0 ? (
            <span className="bold-tb-pill" data-protected="inline-flex">
              {needsCount} need you
            </span>
          ) : (
            <span className="bold-tb-quiet">Nothing needs you</span>
          )}
          <TasksTabs />
        </div>
      </header>

      {making && (
        <NewTaskDialog
          agents={agents}
          rooms={rooms}
          onClose={() => setMaking(false)}
          onCreated={(made) => {
            setMaking(false)
            setSelectedId(made.id)
            setCreatedNote(
              made.startFailed
                ? `Created “${made.title}”. It couldn’t start yet: press Start in its panel.`
                : null,
            )
          }}
        />
      )}
      {createdNote && <p role="status">{createdNote}</p>}

      {loading && <p role="status">Reading tasks…</p>}
      {failed && <p role="alert">Couldn’t read the tasks. Try again in a moment.</p>}
      {none && (
        <p className="bold-tb-none">No tasks yet. Hermes tasks your agents create show up here.</p>
      )}

      {all.length > 0 && (
        <>
          <div className="bold-tb-filters">
            <Chips
              label="Filter by agent"
              options={agentOptions}
              value={agentFilter}
              onPick={setAgentFilter}
            />
            {roomIds.length > 0 && (
              <Chips
                label="Filter by room"
                options={roomOptions}
                value={activeRoom}
                onPick={setRoomFilter}
                className="bold-tb-chips--room"
              />
            )}
          </div>
          {filtered && visible.length === 0 && (
            <p className="bold-tb-none">No tasks match this filter.</p>
          )}

          {phone ? (
            <>
              {grouped.needs_you.length > 0 && (
                <section className="bold-tb-phone-needs" aria-label="Needs you">
                  <h2>Needs you · {grouped.needs_you.length}</h2>
                  {grouped.needs_you.map((task) => (
                    <PhoneNeedsCard
                      key={task.id}
                      task={task}
                      lookup={lookup}
                      onOpen={() => setSelectedId(task.id)}
                    />
                  ))}
                </section>
              )}
              <div className="bold-tb-tabs" role="tablist" aria-label="Columns">
                {PHONE_TABS.map((id) => (
                  <button
                    key={id}
                    type="button"
                    role="tab"
                    aria-selected={phoneTab === id}
                    onClick={() => setPhoneTab(id)}
                  >
                    {BOARD_COLUMNS.find((column) => column.id === id)!.title}{' '}
                    <span>{grouped[id].length}</span>
                  </button>
                ))}
              </div>
              <div role="tabpanel" className="bold-tb-phone-list">
                <Column
                  key={phoneTab}
                  id={phoneTab}
                  title={BOARD_COLUMNS.find((column) => column.id === phoneTab)!.title}
                  tasks={grouped[phoneTab]}
                  lookup={lookup}
                  selectedId={selectedId}
                  onPick={setSelectedId}
                  filtered={filtered}
                />
              </div>
              {selected && (
                <Sheet onClose={() => setSelectedId(null)}>
                  <TaskPanel
                    key={selected.id}
                    task={selected}
                    lookup={lookup}
                    onClose={() => setSelectedId(null)}
                    onArchived={archived}
                  />
                </Sheet>
              )}
            </>
          ) : (
            <div className={`bold-tb-layout${wide ? '' : ' is-sheet'}`}>
              <div className="bold-tb-scroll">
                <div className="bold-tb-grid">
                  {BOARD_COLUMNS.map((column) => (
                    <Column
                      key={column.id}
                      id={column.id}
                      title={column.title}
                      tasks={grouped[column.id]}
                      lookup={lookup}
                      selectedId={selectedId}
                      onPick={setSelectedId}
                      filtered={filtered}
                    />
                  ))}
                </div>
              </div>
              {wide ? (
                <aside className="bold-tb-panel" aria-label="Task details">
                  {selected ? (
                    <TaskPanel
                      key={selected.id}
                      task={selected}
                      lookup={lookup}
                      onClose={() => setSelectedId(null)}
                      onArchived={archived}
                    />
                  ) : (
                    <p className="bold-tb-empty">
                      Pick a task to see its steps, comments and what it needs from you.
                    </p>
                  )}
                </aside>
              ) : (
                selected && (
                  <Sheet side onClose={() => setSelectedId(null)}>
                    <TaskPanel
                      key={selected.id}
                      task={selected}
                      lookup={lookup}
                      onClose={() => setSelectedId(null)}
                      onArchived={archived}
                    />
                  </Sheet>
                )
              )}
            </div>
          )}
        </>
      )}
    </div>
  )
}
