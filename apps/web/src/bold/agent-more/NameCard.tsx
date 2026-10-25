import { useState } from 'react'
import type { AgentDetail } from '@score/contract'
import { Fail, MoreCard, problem } from './MoreCard.tsx'
import { useSaveAgentDetails } from './agent-more-queries.ts'

export function NameCard({ agent }: { agent: AgentDetail }) {
  const [name, setName] = useState(agent.name)
  const [role, setRole] = useState(agent.role)
  const save = useSaveAgentDetails(agent.id)
  return (
    <MoreCard id="agent-details" title="Name and role">
      <form
        className="bold-mc-form"
        onSubmit={(event) => {
          event.preventDefault()
          save.mutate({ name: name.trim(), role: role.trim() })
        }}
      >
        <label className="lab" htmlFor={`name-${agent.id}`}>
          Display name
        </label>
        <input
          id={`name-${agent.id}`}
          className="field"
          required
          maxLength={100}
          value={name}
          onChange={(event) => {
            setName(event.target.value)
            save.reset()
          }}
        />
        <label className="lab" htmlFor={`role-${agent.id}`}>
          Role
        </label>
        <textarea
          id={`role-${agent.id}`}
          className="field"
          required
          maxLength={2000}
          value={role}
          onChange={(event) => {
            setRole(event.target.value)
            save.reset()
          }}
        />
        <span className="small muted">
          Profile name: <code>{agent.id}</code>
        </span>
        <span className="row">
          <button type="submit" className="btn sm" disabled={save.isPending}>
            {save.isPending ? 'Saving…' : 'Save details'}
          </button>
          {save.isSuccess && (
            <span role="status" className="small muted">
              Details saved.
            </span>
          )}
        </span>
        {save.isError && (
          <Fail>{problem(save.error, 'Couldn’t save the details. Try again.')}</Fail>
        )}
      </form>
    </MoreCard>
  )
}
