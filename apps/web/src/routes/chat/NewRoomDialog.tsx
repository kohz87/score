import { RoomSchema, type AgentSummary, type Room } from '@score/contract'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { ApiError, apiFetch } from '../../data/api.ts'
import { AgentChip } from '../orchestrations/RunDecisions.tsx'
import { roomNameProblem } from './room-actions.ts'
import '../orchestrations/orchestrations.css'

/**
 * Starting a room with several agents (owner report 2026-10-11: the button was a placeholder). Messages without an
 * @mention go to the lead, so a room always has one and the lead is always a member.
 */
export function NewRoomDialog({
  agents,
  close,
  created,
}: {
  agents: AgentSummary[]
  close: () => void
  created: (room: Room) => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [name, setName] = useState('')
  const [lead, setLead] = useState(agents[0]?.id ?? '')
  const [members, setMembers] = useState<string[]>([])
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const problem = name ? roomNameProblem(name) : null
  useEffect(() => {
    dialog.current?.showModal?.()
  }, [])
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (!name.trim() || problem || !lead) return
    setBusy(true)
    setError(null)
    try {
      const room = RoomSchema.parse(
        await apiFetch('rooms', {
          method: 'POST',
          body: JSON.stringify({
            name: name.trim(),
            leadAgentId: lead,
            members: [lead, ...members.filter((id) => id !== lead)],
          }),
        }),
      )
      created(room)
    } catch (failure) {
      setBusy(false)
      setError(
        failure instanceof ApiError ? failure.message : 'Couldn’t create the room. Try again.',
      )
    }
  }
  return (
    <dialog
      ref={dialog}
      open={typeof HTMLDialogElement.prototype.showModal !== 'function'}
      className="orch-dialog"
      aria-labelledby="chat-new-room-title"
      onCancel={(event) => {
        event.preventDefault()
        if (!busy) close()
      }}
    >
      <div className="orch-dialog-head">
        <h2 id="chat-new-room-title">New room</h2>
        <button type="button" onClick={close} disabled={busy}>
          Close
        </button>
      </div>
      <p className="orch-muted">
        A room where you talk to several agents. The lead answers messages that don’t @mention
        anyone; @mention an agent to ask it directly.
      </p>
      {agents.length === 0 ? (
        <p role="status">Add an agent in Team first.</p>
      ) : (
        <form onSubmit={(event) => void submit(event)} className="orch-form">
          <label className="orch-field">
            <span>Name</span>
            <input
              required
              autoFocus
              placeholder="launch"
              aria-describedby="chat-new-room-name-hint"
              aria-invalid={problem !== null}
              value={name}
              onChange={(event) => setName(event.target.value)}
            />
          </label>
          <small id="chat-new-room-name-hint" className={problem ? 'orch-error' : 'orch-muted'}>
            {problem ??
              'Lowercase letters, numbers and dashes. Add #tags after a space: “launch #q4”.'}
          </small>
          <label className="orch-field">
            <span>Lead</span>
            <select value={lead} onChange={(event) => setLead(event.target.value)}>
              {agents.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
            </select>
          </label>
          {agents.length > 1 && (
            <fieldset className="orch-field">
              <legend>Other agents in the room</legend>
              <div className="orch-agent-pick">
                {agents
                  .filter((agent) => agent.id !== lead)
                  .map((agent) => (
                    <label key={agent.id} className="orch-check">
                      <input
                        type="checkbox"
                        checked={members.includes(agent.id)}
                        onChange={(event) =>
                          setMembers((list) =>
                            event.target.checked
                              ? [...list, agent.id]
                              : list.filter((id) => id !== agent.id),
                          )
                        }
                      />
                      <AgentChip agentId={agent.id} agents={agents} />
                    </label>
                  ))}
              </div>
            </fieldset>
          )}
          {error && (
            <p role="alert" className="orch-error">
              {error}
            </p>
          )}
          <div className="orch-actions">
            <button
              type="submit"
              className="orch-primary"
              disabled={busy || !name.trim() || problem !== null}
            >
              {busy ? 'Creating…' : 'Create room'}
            </button>
          </div>
        </form>
      )}
    </dialog>
  )
}
