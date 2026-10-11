import type { AgentSummary, Room, RoomProject } from '@score/contract'
import { useState, type FormEvent } from 'react'
import { createProject, deleteProject, PROJECT_COLORS, updateProject } from './conversation-api.ts'
import { RoomLink } from './RoomLink.tsx'
import { RoomMenu } from './RoomMenu.tsx'
import { groupRooms } from './room-groups.ts'

function RoomRow({
  room,
  projects,
  selected,
  agents,
  onShare,
  onDelete,
  onTag,
  activeTag,
  orchestrationRooms,
  workflowRooms,
}: {
  room: Room
  projects: RoomProject[]
  selected: string | undefined
  agents: AgentSummary[]
  onShare?: ((room: Room) => void) | undefined
  onDelete?: ((room: Room) => void) | undefined
  onTag: (tag: string | null) => void
  activeTag: string | null
  orchestrationRooms?: ReadonlySet<string> | undefined
  workflowRooms?: ReadonlySet<string> | undefined
}) {
  return (
    <div className={`chat-room-row${room.archived ? ' chat-room-row--archived' : ''}`}>
      <RoomLink
        room={room}
        selected={selected}
        agents={agents}
        orchestration={
          workflowRooms?.has(room.id) ? 'workflow' : (orchestrationRooms?.has(room.id) ?? false)
        }
      />
      <RoomMenu room={room} projects={projects} onShare={onShare} onDelete={onDelete} />
      {(room.tags ?? []).length > 0 && (
        <ul className="chat-tags" aria-label="Tags">
          {(room.tags ?? []).map((tag) => (
            <li key={tag}>
              <button
                type="button"
                className="chat-tag"
                aria-pressed={activeTag === tag}
                onClick={() => onTag(activeTag === tag ? null : tag)}
              >
                #{tag}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}

function ProjectForm({ project, onDone }: { project?: RoomProject; onDone: () => void }) {
  const [name, setName] = useState(project?.name ?? '')
  const [color, setColor] = useState<string>(project?.color ?? PROJECT_COLORS[0].value)
  const [error, setError] = useState<string | null>(null)
  async function submit(event: FormEvent) {
    event.preventDefault()
    try {
      if (project) await updateProject(project.id, { name: name.trim(), color })
      else await createProject({ name: name.trim(), color })
      onDone()
    } catch {
      setError('Could not save the project. The name may already exist.')
    }
  }
  return (
    <form
      className="chat-project-form"
      aria-label={project ? `Edit project ${project.name}` : 'New project'}
      onSubmit={(event) => void submit(event)}
    >
      <label>
        Project name
        <input
          required
          maxLength={64}
          autoFocus
          value={name}
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      <fieldset>
        <legend>Colour</legend>
        {PROJECT_COLORS.map((choice) => (
          <label key={choice.value} className="chat-swatch">
            <input
              type="radio"
              name="project-color"
              checked={color === choice.value}
              onChange={() => setColor(choice.value)}
            />
            <span style={{ background: choice.value }} aria-hidden="true" />
            <span className="chat-sr-only">{choice.label}</span>
          </label>
        ))}
      </fieldset>
      <div className="chat-menu-actions">
        <button type="submit">Save</button>
        <button type="button" onClick={onDone}>
          Cancel
        </button>
        {project && (
          <button
            type="button"
            onClick={() => {
              void deleteProject(project.id).then(onDone, () => setError('Could not delete it.'))
            }}
          >
            Delete project
          </button>
        )}
      </div>
      {error && <p role="alert">{error}</p>}
    </form>
  )
}

/** The Rooms section of the conversation list: pinned, projects (collapsible), the rest, archived on request. */
export function RoomList({
  rooms,
  projects,
  selected,
  agents,
  onShare,
  onDelete,
  orchestrationRooms,
  workflowRooms,
}: {
  rooms: Room[]
  projects: RoomProject[]
  selected: string | undefined
  agents: AgentSummary[]
  onShare?: ((room: Room) => void) | undefined
  onDelete?: ((room: Room) => void) | undefined
  /** Rooms that belong to an orchestration, marked in the list (they are ordinary rooms otherwise). */
  orchestrationRooms?: ReadonlySet<string> | undefined
  /** The subset of those that belong to a workflow run. */
  workflowRooms?: ReadonlySet<string> | undefined
}) {
  const [showArchived, setShowArchived] = useState(false)
  const [tag, setTag] = useState<string | null>(null)
  const [collapsed, setCollapsed] = useState<ReadonlySet<string>>(new Set())
  const [editing, setEditing] = useState<string | 'new' | null>(null)
  const groups = groupRooms(rooms, projects, { showArchived, tag })
  const row = (room: Room) => (
    <RoomRow
      key={room.id}
      room={room}
      projects={projects}
      selected={selected}
      agents={agents}
      onShare={onShare}
      onDelete={onDelete}
      onTag={setTag}
      activeTag={tag}
      orchestrationRooms={orchestrationRooms}
      workflowRooms={workflowRooms}
    />
  )
  return (
    <>
      <div className="chat-room-group">
        <div className="chat-group-head">
          <h2>Rooms</h2>
          <button type="button" className="chat-small-button" onClick={() => setEditing('new')}>
            ＋ Project
          </button>
        </div>
        {editing === 'new' && <ProjectForm onDone={() => setEditing(null)} />}
        {(groups.tags.length > 0 || tag) && (
          <ul className="chat-tags chat-tags--filter" aria-label="Filter by tag">
            {[...new Set([...(tag ? [tag] : []), ...groups.tags])].map((item) => (
              <li key={item}>
                <button
                  type="button"
                  className="chat-tag"
                  aria-pressed={tag === item}
                  onClick={() => setTag(tag === item ? null : item)}
                >
                  #{item}
                </button>
              </li>
            ))}
          </ul>
        )}
        {groups.pinned.length > 0 && (
          <section aria-label="Pinned rooms" className="chat-subgroup">
            <h3>Pinned</h3>
            {groups.pinned.map(row)}
          </section>
        )}
        {groups.projects.map(({ project, rooms: inProject }) => {
          const isCollapsed = collapsed.has(project.id)
          return (
            <section
              key={project.id}
              aria-label={`Project ${project.name}`}
              className="chat-subgroup"
            >
              <h3>
                <button
                  type="button"
                  className="chat-project-toggle"
                  aria-expanded={!isCollapsed}
                  onClick={() =>
                    setCollapsed((current) => {
                      const next = new Set(current)
                      if (next.has(project.id)) next.delete(project.id)
                      else next.add(project.id)
                      return next
                    })
                  }
                >
                  <span
                    className="chat-project-dot"
                    style={{ background: project.color }}
                    aria-hidden="true"
                  />
                  {project.name}
                  <span className="chat-project-count">{inProject.length}</span>
                </button>
                <button
                  type="button"
                  className="chat-small-button"
                  aria-label={`Edit project ${project.name}`}
                  onClick={() => setEditing(project.id)}
                >
                  Edit
                </button>
              </h3>
              {editing === project.id && (
                <ProjectForm project={project} onDone={() => setEditing(null)} />
              )}
              {!isCollapsed && inProject.map(row)}
              {!isCollapsed && inProject.length === 0 && (
                <p className="chat-list-empty">No rooms in this project.</p>
              )}
            </section>
          )
        })}
        {groups.rest.map(row)}
        {rooms.length === 0 && <p className="chat-list-empty">No rooms yet.</p>}
        {groups.archivedHidden > 0 && (
          <button type="button" className="chat-small-button" onClick={() => setShowArchived(true)}>
            Show archived ({groups.archivedHidden})
          </button>
        )}
        {showArchived && (
          <button
            type="button"
            className="chat-small-button"
            onClick={() => setShowArchived(false)}
          >
            Hide archived
          </button>
        )}
      </div>
    </>
  )
}
