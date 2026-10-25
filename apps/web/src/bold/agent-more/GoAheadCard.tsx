import type { AgentDetail } from '@score/contract'
import {
  usePermissionAction,
  useRules,
  useUseTeamRule,
} from '../../routes/settings/rules-queries.ts'
import { tabFailure } from '../../routes/team/tab-errors.ts'
import { Fail, MoreCard, problem, useFoldedList } from './MoreCard.tsx'

/**
 * What the agent may do without asking, so a standing go-ahead can be taken back here. "Ask first" changes only this
 * agent; "Use team rule" drops this agent's own choice. A decision surface, so it is protected.
 */
export function GoAheadCard({ agent }: { agent: AgentDetail }) {
  const change = usePermissionAction(agent.id)
  const back = useUseTeamRule(agent.id)
  const rules = useRules()
  const goAhead = agent.permissions.filter((row) => row.level === 'allowed')
  // Team go-aheads this agent no longer has: its own "ask first" choice (or a profile that drifted).
  const takenBack = (rules.data?.goAhead ?? []).filter(
    (rule) => !rule.readOnly && !goAhead.some((row) => row.id === rule.id),
  )
  const list = useFoldedList(`goahead:${agent.id}`, goAhead)
  const back2 = useFoldedList(`goahead-back:${agent.id}`, takenBack)
  const busy = change.isPending || back.isPending
  return (
    <MoreCard
      id="agent-goes-ahead"
      title="Goes ahead without asking"
      count={goAhead.length}
      protectedKind="block"
    >
      {change.isError && (
        <Fail>{problem(change.error, tabFailure(change.error, 'change the permission'))}</Fail>
      )}
      {back.isError && (
        <Fail>{problem(back.error, tabFailure(back.error, 'use the team rule'))}</Fail>
      )}
      {!goAhead.length && (
        <p className="small muted">
          Nothing is allowed without asking. Risky commands follow the team’s approval style.
        </p>
      )}
      {list.shown.map((row) => (
        <div className="listrow wrap" key={row.id}>
          <span className="grow small">
            {row.label}{' '}
            <span className="muted">{row.inherited ? 'From the team' : 'Only this agent'}</span>
          </span>
          <button
            type="button"
            className="act"
            disabled={busy}
            aria-label={`Ask first before: ${row.label}`}
            onClick={() => change.mutate({ id: row.id, level: 'asks' })}
          >
            Ask first
          </button>
        </div>
      ))}
      {list.toggle}
      {back2.shown.map((rule) => (
        <div className="listrow wrap" key={rule.id}>
          <span className="grow small">
            {rule.label} <span className="muted">Only this agent asks first</span>
          </span>
          <button
            type="button"
            className="act"
            disabled={busy}
            aria-label={`Use team rule: ${rule.label}`}
            onClick={() => back.mutate(rule.id)}
          >
            Use team rule
          </button>
        </div>
      ))}
      {back2.toggle}
    </MoreCard>
  )
}
