import { RoomSchema, type AgentSummary, type Room, type RoomProject } from '@score/contract'
import { useQueryClient } from '@tanstack/react-query'
import { useEffect, useId, useRef, useState } from 'react'
import { Link } from 'react-router'
import { AgentGlyph } from '../../components/AgentGlyph.tsx'
import { apiFetch, ApiError } from '../../data/api.ts'
import { useStreamQuery } from '../../data/query-client.ts'
import { createProject, patchRoom, PROJECT_COLORS } from '../../routes/chat/conversation-api.ts'
import { agentsQuery } from '../../routes/chat/queries.ts'
import { roomNameProblem } from '../../routes/chat/room-actions.ts'
import { agentDisplayName } from '../bold-agents.ts'
import { setRoomWorkspace, useSharedWorkspaces, workspacesKey } from '../workspaces-queries.ts'
import { teamNameProblem } from './TeamDialogs.tsx'

const NO_AGENTS: AgentSummary[] = []

/**
 * 3.1.0: who leads the team room — unaddressed messages and "lead decides" jobs go to the lead. Any agent that can take
 * work may lead (3.7.5); a coding lead's "lead decides" jobs are planned by a Hermes agent chosen in Start a job.
 */
export function TeamLeadDialog({ room, onClose }: { room: Room; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const all = useStreamQuery(agentsQuery).data ?? NO_AGENTS
  // 3.7.5: coding agents lead rooms too (since 2.0.1); only "lead decides" planning needs a Hermes agent.
  const options = all.filter((agent) => !agent.lifecycle || agent.lifecycle.state === 'ready')
  const [chosen, setChosen] = useState(room.leadAgentId ?? '')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const groupName = useId()
  useEffect(() => {
    dialog.current?.showModal?.()
  }, [])
  const changed = chosen !== '' && chosen !== room.leadAgentId
  async function save() {
    if (!changed || busy) return
    setBusy(true)
    setError(null)
    try {
      // The stream brings the changed room to every view; the reply only proves the server took it.
      RoomSchema.parse(
        await apiFetch(`rooms/${encodeURIComponent(room.id)}`, {
          method: 'PATCH',
          body: JSON.stringify({ leadAgentId: chosen }),
        }),
      )
      onClose()
    } catch (failure) {
      setError(
        failure instanceof ApiError && (failure.status === 401 || failure.status === 403)
          ? 'Pair this browser first.'
          : failure instanceof ApiError && failure.status < 500
            ? failure.message
            : 'Couldn’t change the lead. Try again.',
      )
    } finally {
      setBusy(false)
    }
  }
  return (
    <dialog
      ref={dialog}
      open={typeof HTMLDialogElement.prototype.showModal !== 'function'}
      className="chat-rewind-dialog bold-team-lead-dialog"
      data-protected="any"
      aria-labelledby="team-lead-title"
      onCancel={(event) => {
        event.preventDefault()
        if (!busy) onClose()
      }}
    >
      <h2 id="team-lead-title">Team lead</h2>
      <p className="small muted">
        Messages you don’t address to anyone, and jobs where the lead decides, go to the lead.
      </p>
      <div role="radiogroup" aria-labelledby="team-lead-title" className="bold-team-lead-options">
        {options.map((agent) => (
          <label key={agent.id} className="chip start-agent-chip">
            <input
              type="radio"
              name={groupName}
              value={agent.id}
              checked={chosen === agent.id}
              disabled={busy}
              onChange={() => setChosen(agent.id)}
            />
            <AgentGlyph agent={agent} size="sm" bare decorative />
            <span>{agentDisplayName(agent)}</span>
          </label>
        ))}
        {options.length === 0 && <p className="small muted">No agent can lead right now.</p>}
      </div>
      {options.find((agent) => agent.id === chosen)?.runtime &&
        options.find((agent) => agent.id === chosen)?.runtime !== 'hermes' && (
          <p className="small muted">
            A coding agent leads the room’s messages and hand-offs. A “lead decides” job is planned
            by a Hermes agent you pick when you start it.
          </p>
        )}
      {error && (
        <p className="chat-rewind-warning" role="alert">
          {error}
        </p>
      )}
      <div className="chat-rewind-actions">
        <button type="button" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button
          type="button"
          className="chat-rewind-primary"
          disabled={!changed || busy}
          onClick={() => void save()}
        >
          {busy ? 'Saving…' : 'Make lead'}
        </button>
      </div>
    </dialog>
  )
}

export function RenameRoomDialog({ room, onClose }: { room: Room; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [text, setText] = useState(room.name)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    dialog.current?.showModal?.()
  }, [])
  async function rename() {
    if (busy) return
    const problem = room.role === 'team' ? teamNameProblem(text) : roomNameProblem(text)
    if (problem) return setError(problem)
    const name = text.trim()
    if (name === room.name || `#${name}` === room.name) return onClose()
    setBusy(true)
    setError(null)
    try {
      // The new name arrives on the stream as room.upserted.
      await patchRoom(room.id, { name })
      onClose()
    } catch (failure) {
      setBusy(false)
      setError(
        failure instanceof ApiError && failure.status === 409
          ? 'Another room already has that name.'
          : 'Couldn’t rename the room. Try again.',
      )
    }
  }
  return (
    <dialog
      ref={dialog}
      open={typeof HTMLDialogElement.prototype.showModal !== 'function'}
      className="chat-rewind-dialog bold-room-rename-dialog"
      data-protected="any"
      aria-labelledby="rename-room-title"
      onCancel={(event) => {
        event.preventDefault()
        if (!busy) onClose()
      }}
    >
      <h2 id="rename-room-title">Rename room</h2>
      <label className="chat-delete-confirm">
        <span>Name</span>
        <input
          value={text}
          autoFocus
          autoComplete="off"
          maxLength={200}
          disabled={busy}
          aria-invalid={error !== null}
          onChange={(event) => {
            setText(event.target.value)
            setError(null)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              void rename()
            }
          }}
        />
      </label>
      {error && (
        <p className="chat-rewind-warning" role="alert">
          {error}
        </p>
      )}
      <div className="chat-rewind-actions">
        <button type="button" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button
          type="button"
          className="chat-rewind-primary"
          disabled={busy || !text.trim()}
          onClick={() => void rename()}
        >
          {busy ? 'Renaming…' : 'Rename'}
        </button>
      </div>
    </dialog>
  )
}

/** Choose, create or clear the room's project (PLAN 5.26 routes). */
export function RoomProjectDialog({
  room,
  projects,
  onClose,
}: {
  room: Room
  projects: RoomProject[]
  onClose: () => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [choice, setChoice] = useState<string | null>(room.projectId ?? null)
  const [name, setName] = useState('')
  const [color, setColor] = useState<string>(PROJECT_COLORS[0].value)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    dialog.current?.showModal?.()
  }, [])
  const creating = name.trim().length > 0
  async function save() {
    if (busy) return
    setBusy(true)
    setError(null)
    try {
      let projectId = choice
      if (creating) projectId = (await createProject({ name: name.trim(), color })).id
      if (projectId !== (room.projectId ?? null)) await patchRoom(room.id, { projectId })
      onClose()
    } catch (failure) {
      setBusy(false)
      setError(
        failure instanceof ApiError && failure.status === 409
          ? 'A project with that name already exists. Choose it from the list.'
          : 'Couldn’t save the project. Try again.',
      )
    }
  }
  return (
    <dialog
      ref={dialog}
      open={typeof HTMLDialogElement.prototype.showModal !== 'function'}
      className="chat-rewind-dialog bold-room-project-dialog"
      data-protected="any"
      aria-labelledby="room-project-title"
      onCancel={(event) => {
        event.preventDefault()
        if (!busy) onClose()
      }}
    >
      <h2 id="room-project-title">Project for {room.name}</h2>
      <div role="radiogroup" aria-label="Project" className="bold-room-project-list">
        {[{ id: null, name: 'No project' }, ...projects].map((project) => (
          <label key={project.id ?? 'none'} className="bold-room-project-option">
            <input
              type="radio"
              name="room-project"
              checked={!creating && choice === project.id}
              disabled={busy || creating}
              onChange={() => setChoice(project.id)}
            />
            <span>{project.name}</span>
          </label>
        ))}
      </div>
      <label className="chat-delete-confirm">
        <span>Or a new project</span>
        <input
          value={name}
          autoComplete="off"
          maxLength={60}
          disabled={busy}
          placeholder="Project name"
          onChange={(event) => setName(event.target.value)}
        />
      </label>
      {creating && (
        <div role="radiogroup" aria-label="Project colour" className="bold-room-project-colours">
          {PROJECT_COLORS.map((item) => (
            <label key={item.value} className="bold-room-project-option">
              <input
                type="radio"
                name="room-project-colour"
                checked={color === item.value}
                disabled={busy}
                onChange={() => setColor(item.value)}
              />
              <span>{item.label}</span>
            </label>
          ))}
        </div>
      )}
      {error && (
        <p className="chat-rewind-warning" role="alert">
          {error}
        </p>
      )}
      <div className="chat-rewind-actions">
        <button type="button" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button
          type="button"
          className="chat-rewind-primary"
          disabled={busy}
          onClick={() => void save()}
        >
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    </dialog>
  )
}

/** 3.20.0: the workspace this room's agents work in (Settings › Workspaces makes them). */
export function RoomWorkspaceDialog({ room, onClose }: { room: Room; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const queryClient = useQueryClient()
  const workspaces = useSharedWorkspaces()
  const [choice, setChoice] = useState<string | null>(room.workspaceId ?? null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  useEffect(() => {
    dialog.current?.showModal?.()
  }, [])
  async function save() {
    if (busy) return
    if (choice === (room.workspaceId ?? null)) return onClose()
    setBusy(true)
    setError(null)
    try {
      // The room arrives on the stream as room.upserted; the Settings list counts rooms, so it is refetched.
      await setRoomWorkspace(room.id, choice)
      await queryClient.invalidateQueries({ queryKey: workspacesKey })
      onClose()
    } catch {
      setBusy(false)
      setError('Couldn’t set the workspace. Try again.')
    }
  }
  return (
    <dialog
      ref={dialog}
      open={typeof HTMLDialogElement.prototype.showModal !== 'function'}
      className="chat-rewind-dialog bold-room-project-dialog"
      data-protected="any"
      aria-labelledby="room-workspace-title"
      onCancel={(event) => {
        event.preventDefault()
        if (!busy) onClose()
      }}
    >
      <h2 id="room-workspace-title">Workspace for {room.name}</h2>
      <p className="small muted">
        Coding agents ticked for the workspace work in its folder here; everyone else keeps their
        own.
      </p>
      <div role="radiogroup" aria-label="Workspace" className="bold-room-project-list">
        {[{ id: null, name: 'No workspace' }, ...(workspaces.data ?? [])].map((workspace) => (
          <label key={workspace.id ?? 'none'} className="bold-room-project-option">
            <input
              type="radio"
              name="room-workspace"
              checked={choice === workspace.id}
              disabled={busy}
              onChange={() => setChoice(workspace.id)}
            />
            <span>{workspace.name}</span>
          </label>
        ))}
      </div>
      {workspaces.isPending && <p role="status">Loading workspaces…</p>}
      {workspaces.isError && <p role="alert">Couldn’t load the workspaces.</p>}
      {workspaces.isSuccess && workspaces.data.length === 0 && (
        <p className="small muted">
          No workspaces yet.{' '}
          <Link to="/b/settings/workspaces">Add one in Settings › Workspaces</Link>.
        </p>
      )}
      {error && (
        <p className="chat-rewind-warning" role="alert">
          {error}
        </p>
      )}
      <div className="chat-rewind-actions">
        <button type="button" onClick={onClose} disabled={busy}>
          Cancel
        </button>
        <button
          type="button"
          className="chat-rewind-primary"
          disabled={busy}
          onClick={() => void save()}
        >
          {busy ? 'Saving…' : 'Save'}
        </button>
      </div>
    </dialog>
  )
}
