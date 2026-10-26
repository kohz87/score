import { RoomSchema, type AgentSummary, type Room } from '@score/contract'
import { useEffect, useId, useRef, useState } from 'react'
import { AgentGlyph } from '../../components/AgentGlyph.tsx'
import { apiFetch, ApiError } from '../../data/api.ts'
import { useStreamQuery } from '../../data/query-client.ts'
import { agentsQuery } from '../../routes/chat/queries.ts'
import { agentDisplayName } from '../bold-agents.ts'

const NO_AGENTS: AgentSummary[] = []

/** A team's name is plain text (1–80 characters, no control characters), unlike an older room's slug. */
export function teamNameProblem(text: string): string | null {
  const name = text.trim()
  if (!name) return 'Give the team a name.'
  if (name.length > 80) return 'Use 80 characters or fewer.'
  // eslint-disable-next-line no-control-regex -- rejecting control characters is the point
  if (/[\u0000-\u001f\u007f-\u009f]/.test(name)) return 'Use plain text without control characters.'
  return null
}

function failureText(failure: unknown, fallback: string): string {
  return failure instanceof ApiError && (failure.status === 401 || failure.status === 403)
    ? 'Pair this browser first.'
    : failure instanceof ApiError && failure.status === 409
      ? 'Another room already has that name.'
      : failure instanceof ApiError && failure.status < 500
        ? failure.message
        : fallback
}

/** Agents that can join a team: ready ones only (the server refuses the rest). */
function useReadyAgents(): AgentSummary[] {
  const all = useStreamQuery(agentsQuery).data ?? NO_AGENTS
  return all.filter((agent) => !agent.lifecycle || agent.lifecycle.state === 'ready')
}

function MemberChecklist({
  agents,
  chosen,
  locked,
  disabled,
  labelledBy,
  onToggle,
}: {
  agents: AgentSummary[]
  chosen: string[]
  /** An agent that can't be unchecked here (the lead), with why. */
  locked?: string | null
  disabled: boolean
  labelledBy: string
  onToggle: (agentId: string) => void
}) {
  return (
    <div role="group" aria-labelledby={labelledBy} className="bold-team-pick">
      {agents.map((agent) => (
        <label key={agent.id} className="chip start-agent-chip">
          <input
            type="checkbox"
            value={agent.id}
            checked={chosen.includes(agent.id)}
            disabled={disabled || locked === agent.id}
            onChange={() => onToggle(agent.id)}
          />
          <AgentGlyph agent={agent} size="sm" bare decorative />
          <span>{agentDisplayName(agent)}</span>
        </label>
      ))}
      {agents.length === 0 && <p className="small muted">No agent is ready yet.</p>}
    </div>
  )
}

function toggled(list: string[], agentId: string): string[] {
  return list.includes(agentId) ? list.filter((id) => id !== agentId) : [...list, agentId]
}

/** 3.4.0: make a team of the agents you choose, with a lead from among them. */
export function NewTeamDialog({
  onClose,
  onCreated,
}: {
  onClose: () => void
  onCreated: (room: Room) => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const agents = useReadyAgents()
  const [name, setName] = useState('')
  const [members, setMembers] = useState<string[]>([])
  const [lead, setLead] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const titleId = useId()
  const membersId = useId()
  useEffect(() => {
    dialog.current?.showModal?.()
  }, [])
  // The lead must be a checked member that can take work (a Hermes agent, as in Team lead…).
  const leadOptions = agents.filter(
    (agent) => members.includes(agent.id) && (!agent.runtime || agent.runtime === 'hermes'),
  )
  const leadId = leadOptions.some((agent) => agent.id === lead) ? lead : ''
  async function create() {
    if (busy) return
    const problem = teamNameProblem(name)
    if (problem) return setError(problem)
    if (members.length === 0) return setError('Pick at least one agent.')
    if (!leadId) return setError('Choose a lead from the members.')
    setBusy(true)
    setError(null)
    try {
      const room = RoomSchema.parse(
        await apiFetch('team-rooms', {
          method: 'POST',
          body: JSON.stringify({ name: name.trim(), members, leadAgentId: leadId }),
        }),
      )
      onCreated(room)
    } catch (failure) {
      setBusy(false)
      setError(failureText(failure, 'Couldn’t make the team. Try again.'))
    }
  }
  return (
    <dialog
      ref={dialog}
      open={typeof HTMLDialogElement.prototype.showModal !== 'function'}
      className="chat-rewind-dialog bold-new-team-dialog"
      data-protected="any"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault()
        if (!busy) onClose()
      }}
    >
      <h2 id={titleId}>New team</h2>
      <p className="small muted">
        A team room of its own, with the agents you pick. An agent can be in several teams.
      </p>
      <label className="chat-delete-confirm">
        <span>Name</span>
        <input
          value={name}
          autoFocus
          autoComplete="off"
          maxLength={80}
          disabled={busy}
          aria-invalid={error !== null && teamNameProblem(name) !== null}
          onChange={(event) => {
            setName(event.target.value)
            setError(null)
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              event.preventDefault()
              void create()
            }
          }}
        />
      </label>
      <div className="chat-delete-confirm">
        <span id={membersId}>Members</span>
        <MemberChecklist
          agents={agents}
          chosen={members}
          disabled={busy}
          labelledBy={membersId}
          onToggle={(agentId) => {
            setMembers((list) => toggled(list, agentId))
            setError(null)
          }}
        />
      </div>
      <label className="chat-delete-confirm">
        <span>Lead</span>
        <select
          value={leadId}
          disabled={busy || leadOptions.length === 0}
          onChange={(event) => {
            setLead(event.target.value)
            setError(null)
          }}
        >
          <option value="">
            {leadOptions.length === 0 ? 'Pick members first' : 'Choose a lead'}
          </option>
          {leadOptions.map((agent) => (
            <option key={agent.id} value={agent.id}>
              {agentDisplayName(agent)}
            </option>
          ))}
        </select>
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
          disabled={busy || !name.trim() || members.length === 0 || !leadId}
          onClick={() => void create()}
        >
          {busy ? 'Making…' : 'Create team'}
        </button>
      </div>
    </dialog>
  )
}

/** 3.4.0: who is in a chosen team. The lead stays checked (change the lead first). */
export function TeamMembersDialog({ room, onClose }: { room: Room; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const ready = useReadyAgents()
  const all = useStreamQuery(agentsQuery).data ?? NO_AGENTS
  // Members that are not ready (or left) stay listed so they can be taken out.
  const agents = [
    ...ready,
    ...all.filter((agent) => room.members.includes(agent.id) && !ready.includes(agent)),
  ]
  const [members, setMembers] = useState<string[]>(room.members)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const titleId = useId()
  useEffect(() => {
    dialog.current?.showModal?.()
  }, [])
  const changed =
    members.length !== room.members.length || members.some((id) => !room.members.includes(id))
  async function save() {
    if (!changed || busy || members.length === 0) return
    setBusy(true)
    setError(null)
    try {
      // The stream brings the changed room to every view; the reply only proves the server took it.
      RoomSchema.parse(
        await apiFetch(`rooms/${encodeURIComponent(room.id)}`, {
          method: 'PATCH',
          body: JSON.stringify({ members }),
        }),
      )
      onClose()
    } catch (failure) {
      setBusy(false)
      setError(failureText(failure, 'Couldn’t change the members. Try again.'))
    }
  }
  return (
    <dialog
      ref={dialog}
      open={typeof HTMLDialogElement.prototype.showModal !== 'function'}
      className="chat-rewind-dialog bold-team-members-dialog"
      data-protected="any"
      aria-labelledby={titleId}
      onCancel={(event) => {
        event.preventDefault()
        if (!busy) onClose()
      }}
    >
      <h2 id={titleId}>Members of {room.name}</h2>
      <MemberChecklist
        agents={agents}
        chosen={members}
        locked={room.leadAgentId}
        disabled={busy}
        labelledBy={titleId}
        onToggle={(agentId) => {
          setMembers((list) => toggled(list, agentId))
          setError(null)
        }}
      />
      {room.leadAgentId && (
        <p className="small muted">
          The lead stays a member. Change the lead first to remove them.
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
          disabled={!changed || busy || members.length === 0}
          onClick={() => void save()}
        >
          {busy ? 'Saving…' : 'Save members'}
        </button>
      </div>
    </dialog>
  )
}
