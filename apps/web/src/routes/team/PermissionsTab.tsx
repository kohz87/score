import { useState, type FormEvent } from 'react'
import { Link } from 'react-router'
import type { AgentDetail } from '@score/contract'
import { ApiError } from '../../data/api.ts'
import { usePermissionAction, useRules, useUseTeamRule } from '../settings/rules-queries.ts'
import { tabFailure } from './tab-errors.ts'

const NEVER_PREFIX = 'never:'

function failure(error: unknown, action: string): string {
  if (error instanceof ApiError && error.code === 'not_stricter')
    return 'An agent can only be made stricter than the team rules, never looser.'
  if (error instanceof ApiError && error.code === 'not_an_override')
    return 'That rule comes from the team. Change it in Settings.'
  if (error instanceof ApiError && error.status === 404 && action === 'use the team rule')
    return 'This rule was not set from Score, so it cannot be removed here.'
  if (error instanceof ApiError && error.status === 400)
    return 'That rule was not accepted. Check the wording and try again.'
  return tabFailure(error, action)
}

export function PermissionsTab({ agent }: { agent: AgentDetail }) {
  const change = usePermissionAction(agent.id)
  const back = useUseTeamRule(agent.id)
  const rules = useRules()
  const [glob, setGlob] = useState('')
  const goAhead = agent.permissions.filter((row) => row.level === 'allowed')
  const never = agent.permissions.filter((row) => row.level === 'never')
  // Team Go-aheads this agent no longer has: its own "ask first" choice (or a profile that drifted).
  const takenBack = (rules.data?.goAhead ?? []).filter(
    (rule) => !rule.readOnly && !goAhead.some((row) => row.id === rule.id),
  )
  const busy = change.isPending || back.isPending

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
    <section
      className="team-card team-permissions"
      aria-labelledby="team-permissions-heading"
      data-protected="block"
    >
      <h2 id="team-permissions-heading">Permissions</h2>
      <p className="team-muted-strong">
        {agent.name} starts from the <Link to="/settings/rules">team rules in Settings</Link>. Here
        you can only make this agent stricter, never looser.
      </p>
      {change.isError && <p role="alert">{failure(change.error, 'change the permission')}</p>}
      {back.isError && <p role="alert">{failure(back.error, 'use the team rule')}</p>}

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
                disabled={busy}
                onClick={() => change.mutate({ id: row.id, level: 'asks' })}
              >
                Ask first
              </button>
            </li>
          ))}
        </ul>
      )}

      {takenBack.length > 0 && (
        <ul
          className="team-rows"
          aria-label={`${agent.name} asks first, although the team allows these`}
        >
          {takenBack.map((rule) => (
            <li key={rule.id}>
              <span>
                {rule.label}
                <small> Only this agent asks first</small>
              </span>
              <button
                type="button"
                className="team-pill-button"
                aria-label={`Use team rule: ${rule.label}`}
                disabled={busy}
                onClick={() => back.mutate(rule.id)}
              >
                Use team rule
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
              {!row.inherited && (
                <button
                  type="button"
                  className="team-pill-button"
                  aria-label={`Use team rule instead of: ${row.label}`}
                  disabled={busy}
                  onClick={() => back.mutate(row.id)}
                >
                  Use team rule
                </button>
              )}
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
        <button type="submit" className="team-pill-button" disabled={busy || !glob.trim()}>
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
