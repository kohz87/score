import { useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import type { AgentDetail } from '@score/contract'
import { ApiError } from '../../data/api.ts'
import { usePermissionAction } from '../settings/rules-queries.ts'
import { tabFailure } from './tab-errors.ts'

const NEVER_PREFIX = 'never:'

function failure(error: unknown, action: string): string {
  if (error instanceof ApiError && error.code === 'not_stricter')
    return 'An agent can only be made stricter than the team rules, never looser.'
  if (error instanceof ApiError && error.status === 400)
    return 'That rule was not accepted. Check the wording and try again.'
  return tabFailure(error, action)
}

export function PermissionsTab({ agent }: { agent: AgentDetail }) {
  const change = usePermissionAction(agent.id)
  const [glob, setGlob] = useState('')
  const goAhead = agent.permissions.filter((row) => row.level === 'allowed')
  const never = agent.permissions.filter((row) => row.level === 'never')

  function addNever(event: FormEvent) {
    event.preventDefault()
    const value = glob.trim().replace(/\s+/g, ' ')
    if (!value) return
    change.mutate(
      { id: `${NEVER_PREFIX}${value}`, level: 'never' },
      { onSuccess: () => setGlob('') },
    )
  }

  return (
    <section className="team-card" aria-labelledby="team-permissions-heading">
      <h2 id="team-permissions-heading">Permissions</h2>
      <p className="team-muted-strong">
        {agent.name} starts from the <Link to="/settings#rules">team rules in Settings</Link>. Here
        you can only make this agent stricter, never looser.
      </p>
      {change.isError && <p role="alert">{failure(change.error, 'change the permission')}</p>}

      <h3 className="team-subheading">Go ahead</h3>
      {goAhead.length === 0 ? (
        <p className="team-muted">
          Nothing is allowed without asking. Risky commands follow the approval style set for the
          team.
        </p>
      ) : (
        <ul className="team-rows" aria-label={`${agent.name} may do these without asking`}>
          {goAhead.map((row) => (
            <li key={row.id}>
              <span>
                {row.label}
                <small>{row.inherited ? ' From the team' : ' Only this agent'}</small>
              </span>
              <button
                type="button"
                className="team-pill-button"
                aria-label={`Ask first before: ${row.label}`}
                disabled={change.isPending}
                onClick={() => change.mutate({ id: row.id, level: 'asks' })}
              >
                Ask first
              </button>
            </li>
          ))}
        </ul>
      )}

      <h3 className="team-subheading">Never</h3>
      {never.length === 0 ? (
        <p className="team-muted">No Never rules yet.</p>
      ) : (
        <ul className="team-rows" aria-label={`${agent.name} never does these`}>
          {never.map((row) => (
            <li key={row.id}>
              <code>{row.label}</code>
              <small>{row.inherited ? 'From the team' : 'Only this agent'}</small>
            </li>
          ))}
        </ul>
      )}
      <form className="team-permission-form" onSubmit={addNever} aria-label="Add a Never rule">
        <label>
          Never allow commands that match
          <input
            value={glob}
            maxLength={200}
            placeholder="*git* push* --force*"
            onChange={(event) => setGlob(event.target.value)}
          />
        </label>
        <button
          type="submit"
          className="team-pill-button"
          disabled={change.isPending || !glob.trim()}
        >
          Add Never rule
        </button>
      </form>
      <p className="team-muted">
        Never rules are guardrails, not a security boundary: they match the command text, so an
        alias or a subshell can get past them.
      </p>
    </section>
  )
}
