import type { AgentSummary, CostSource } from '@score/contract'
import { AgentGlyph } from '../../components/AgentGlyph.tsx'
import { runtimeLabel } from '../../components/runtime-label.ts'
import { describeOrchError } from './orchestration-queries.ts'

// The small parts every decision card and run page shares.

export function AgentChip({ agentId, agents }: { agentId: string; agents: AgentSummary[] }) {
  const agent = agents.find((item) => item.id === agentId)
  return (
    <span className="orch-agent">
      {agent && <AgentGlyph agent={agent} size="xs" describeShape />}
      <span>{agent?.name ?? agentId}</span>
      <CliBadge runtime={agent?.runtime} />
    </span>
  )
}

/** Which program a coding agent runs on (Claude Code, Codex); nothing for Hermes agents. */
export function CliBadge({ runtime }: { runtime: AgentSummary['runtime'] }) {
  const label = runtimeLabel(runtime)
  return label ? <span className="orch-cli">{label}</span> : null
}

export const sourceName = (source: CostSource): string =>
  source === 'claude-code' ? 'Claude Code' : source === 'codex' ? 'Codex' : 'Hermes agents'

export function ErrorLine({ error }: { error: unknown }) {
  return error ? (
    <p role="alert" className="orch-error">
      {describeOrchError(error)}
    </p>
  ) : null
}
