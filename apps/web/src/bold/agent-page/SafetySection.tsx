import type { AgentDetail } from '@score/contract'
import { GoAheadCard } from '../agent-more/GoAheadCard.tsx'
import { NeverCard } from '../agent-more/NeverCard.tsx'
import { RunsOnCard } from '../BoldRunsOn.tsx'
import { AsksCard } from './AsksCard.tsx'

/** Safety (mock-up 26): four tiles for what the person decides: where it runs, asks first, goes ahead, never. */
export function SafetySection({ agent }: { agent: AgentDetail }) {
  return (
    <section className="bold-agent-section" id="agent-safety" aria-labelledby="agent-safety-title">
      <h2 id="agent-safety-title">Safety</h2>
      <div className="bold-agent-tiles">
        <RunsOnCard agent={agent} />
        <AsksCard agent={agent} />
        <GoAheadCard agent={agent} />
        <NeverCard agent={agent} />
      </div>
    </section>
  )
}
