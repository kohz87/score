import type { AgentSummary } from '@score/contract'
import { ModelListSection } from '../routes/settings/ModelListSection.tsx'
import { ChannelsCard } from './connections/ChannelsCard.tsx'
import { HermesCard } from './connections/HermesCard.tsx'
import { ModelProvidersCard } from './connections/ModelProvidersCard.tsx'
import { OtherAppsCard } from './connections/OtherAppsCard.tsx'
import { PhoneCard } from './connections/PhoneCard.tsx'

/** PLAN 11.9a: Settings › Connections, rebuilt from the prototype's sConn() and board 15. */
export function BoldConnections({ agents }: { agents: AgentSummary[] }) {
  return (
    <div className="bold-connections">
      <h2 id="settings-connections">Connections</h2>
      <div className="grid2">
        <HermesCard agents={agents} />
        <ModelProvidersCard agents={agents} />
        <div className="span2">
          <ModelListSection agents={agents} />
        </div>
        <ChannelsCard />
        <PhoneCard />
        <OtherAppsCard />
      </div>
    </div>
  )
}
