import type { AgentDetail } from '@score/contract'
import { AsksTile, GoAheadTile, NeverTile, RunsOnTile } from './SafetyTiles.tsx'

/** Safety (mock-up 26): four tiles for what the person decides: where it runs, asks first, goes ahead, never. */
export function SafetySection({
  agent,
  initialOpen,
}: {
  agent: AgentDetail
  initialOpen?: string
}) {
  return (
    <section className="bold-agent-section" id="agent-safety" aria-labelledby="agent-safety-title">
      <h2 id="agent-safety-title">Safety</h2>
      <div className="bold-agent-tiles">
        <RunsOnTile agent={agent} initialOpen={initialOpen === 'where'} />
        <AsksTile agent={agent} initialOpen={initialOpen === 'asks'} />
        <GoAheadTile agent={agent} initialOpen={initialOpen === 'goes-ahead'} />
        <NeverTile agent={agent} initialOpen={initialOpen === 'never'} />
      </div>
    </section>
  )
}
