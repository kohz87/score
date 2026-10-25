import type { AgentDetail } from '@score/contract'
import { Link } from 'react-router'
import { useToolAction } from '../../routes/team/agent-tab-queries.ts'
import {
  useKnowledgeAccess,
  useSetKnowledgeAccess,
} from '../../routes/team/knowledge-access-queries.ts'
import { tabFailure } from '../../routes/team/tab-errors.ts'
import { boldSettingsSectionLink } from '../bold-links.ts'
import { Fail, MoreCard } from './MoreCard.tsx'

export function CanUseCard({ agent, coding }: { agent: AgentDetail; coding: boolean }) {
  const change = useToolAction(agent.id)
  const knowledge = useKnowledgeAccess(agent.id)
  const setKnowledge = useSetKnowledgeAccess(agent.id)
  const servers = agent.tools.filter((tool) => tool.kind === 'mcp')
  const builtin = agent.tools.filter((tool) => tool.kind === 'builtin')
  return (
    <MoreCard id="agent-tools" title="Can use">
      {!builtin.length && (
        <p className="small muted">
          {coding
            ? 'Its coding tool decides what it can use. What it may change is set above.'
            : 'No tools available.'}
        </p>
      )}
      {change.isError && <Fail>{tabFailure(change.error, 'change the tool')}</Fail>}
      {builtin.map((tool) => (
        <label className="check" key={tool.id}>
          <input
            type="checkbox"
            checked={tool.enabled}
            disabled={change.isPending}
            onChange={() => change.mutate({ id: tool.id, enabled: !tool.enabled })}
          />
          {tool.label}
        </label>
      ))}
      {!coding && !knowledge.isError && (
        <label className="check">
          <input
            type="checkbox"
            checked={knowledge.data?.enabled ?? false}
            disabled={!knowledge.data || setKnowledge.isPending}
            onChange={() => setKnowledge.mutate(!knowledge.data?.enabled)}
          />
          Library notes
        </label>
      )}
      {setKnowledge.isError && <Fail>{tabFailure(setKnowledge.error, 'change this setting')}</Fail>}
      <span className="small muted">
        Tool servers:{' '}
        {servers.length
          ? servers.map((tool) => `${tool.label}${tool.enabled ? '' : ' (off)'}`).join(', ')
          : 'none'}{' '}
        ·{' '}
        <Link className="link" to={boldSettingsSectionLink('tools')}>
          Manage
        </Link>
      </span>
      {agent.helpersMax !== null && (
        <span className="small muted">Helpers it can start: up to {agent.helpersMax}</span>
      )}
    </MoreCard>
  )
}
