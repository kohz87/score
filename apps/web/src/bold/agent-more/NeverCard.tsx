import { useState, type FormEvent } from 'react'
import type { AgentDetail } from '@score/contract'
import { Link } from 'react-router'
import { ApiError } from '../../data/api.ts'
import { usePermissionAction, useUseTeamRule } from '../../routes/settings/rules-queries.ts'
import { tabFailure } from '../../routes/team/tab-errors.ts'
import { boldSettingsSectionLink } from '../bold-links.ts'
import { CloseIcon } from '../BoldIcons.tsx'
import { Fail, MoreCard, useFoldedList } from './MoreCard.tsx'

function failure(error: unknown, action: string): string {
  if (error instanceof ApiError && error.code === 'not_stricter')
    return 'An agent can only be made stricter than the team rules, never looser.'
  if (error instanceof ApiError && error.status === 400)
    return 'That rule was not accepted. Check the wording and try again.'
  return tabFailure(error, action)
}

/** The add-a-rule line: one input and Add. The Safety tile shows it inline; the full card shows it under the list. */
export function NeverAddForm({ agent }: { agent: AgentDetail }) {
  const change = usePermissionAction(agent.id)
  const [glob, setGlob] = useState('')

  function add(event: FormEvent) {
    event.preventDefault()
    const value = glob.trim().replace(/\s+/g, ' ')
    if (!value) return
    change.mutate({ id: `never:${value}`, level: 'never' }, { onSuccess: () => setGlob('') })
  }
  return (
    <>
      <form className="row bold-never-add" onSubmit={add} aria-label="Add a Never rule">
        <label htmlFor={`never-${agent.id}`} className="sr">
          Never allow commands that match
        </label>
        <input
          id={`never-${agent.id}`}
          className="field"
          maxLength={200}
          placeholder="git push --force"
          value={glob}
          onChange={(event) => setGlob(event.target.value)}
        />
        <button type="submit" className="btn sm" disabled={change.isPending || !glob.trim()}>
          Add
        </button>
      </form>
      {change.isError && <Fail>{failure(change.error, 'change the permission')}</Fail>}
    </>
  )
}

/** The Never rules of this agent: stricter than the team, never looser. A decision surface, so it is protected. */
export function NeverCard({ agent }: { agent: AgentDetail }) {
  const back = useUseTeamRule(agent.id)
  const never = agent.permissions.filter((row) => row.level === 'never')
  const list = useFoldedList(`never:${agent.id}`, never)

  return (
    <MoreCard id="agent-permissions" title="Never rules" count={never.length} protectedKind="block">
      <span className="small muted">
        Commands that match are refused. Stricter than the team rules is fine; looser isn’t.{' '}
        <Link className="link" to={boldSettingsSectionLink('rules')}>
          Team rules
        </Link>
      </span>
      {back.isError && <Fail>{failure(back.error, 'use the team rule')}</Fail>}
      {!never.length && <p className="small muted">No Never rules yet.</p>}
      <div id={list.id} className="bold-fold-list">
        {list.shown.map((row) => (
          <div className="listrow" key={row.id}>
            <code className="grow small">{row.label}</code>
            <span className="small muted">{row.inherited ? 'Team' : 'Only this agent'}</span>
            {!row.inherited && (
              <button
                type="button"
                className="act"
                aria-label={`Use team rule instead of: ${row.label}`}
                disabled={back.isPending}
                onClick={() => back.mutate(row.id)}
              >
                <CloseIcon size={12} />
              </button>
            )}
          </div>
        ))}
      </div>
      {list.toggle}
      <NeverAddForm agent={agent} />
      <span className="small muted">
        Guardrails, not a security boundary: they match the command text.
      </span>
    </MoreCard>
  )
}
