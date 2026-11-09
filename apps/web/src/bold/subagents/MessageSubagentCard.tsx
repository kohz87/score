import type { AgentSummary, SubagentRow } from '@score/contract'
import { SubagentStatusCard } from './SubagentStatusCard.tsx'

/** The status card under the message that started a job's subagents: nothing when the message started none. */
export function MessageSubagentCard({
  rows,
  agents,
}: {
  rows: readonly SubagentRow[] | undefined
  agents: AgentSummary[]
}) {
  if (!rows || rows.length === 0) return null
  const agentId = rows[0]!.agentId
  return <SubagentStatusCard rows={rows} agent={agents.find((agent) => agent.id === agentId)} />
}
