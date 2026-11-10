import { useState } from 'react'
import type { AgentDetail } from '@score/contract'
import { usePlugins } from '../../routes/settings/settings-queries.ts'
import { CanUseCard } from '../agent-more/CanUseCard.tsx'
import { ChannelsCard } from '../agent-more/ChannelsCard.tsx'
import { PluginsCard } from '../agent-more/PluginsCard.tsx'
import { ScoreAccessCard } from '../agent-more/ScoreAccessCard.tsx'
import { OpenCard } from './OpenCard.tsx'

/** Tools (mock-up 26): Can use, Plugins (a summary and Manage), Reachable on (Channels) and Score access. */
export function ToolsSection({
  agent,
  coding,
  initialOpen,
}: {
  agent: AgentDetail
  coding: boolean
  initialOpen?: string
}) {
  const [plugins, setPlugins] = useState(initialOpen === 'plugins')
  const list = usePlugins(coding ? undefined : agent.id)
  const on = (list.data ?? []).filter((plugin) => plugin.enabled)
  return (
    <section
      className="bold-agent-section"
      id="agent-section-tools"
      aria-labelledby="agent-section-tools-title"
    >
      <h2 id="agent-section-tools-title">Tools</h2>
      <div className="bold-agent-tiles">
        <CanUseCard agent={agent} coding={coding} />
        {!coding && (
          <OpenCard
            open={plugins}
            onOpen={() => setPlugins(true)}
            onClose={() => setPlugins(false)}
            title={`Plugins${list.isSuccess ? ` · ${on.length} on` : ''}`}
            summary={
              list.isPending
                ? 'Loading plugins…'
                : list.isError
                  ? 'Couldn’t load plugins. Check that Hermes is reachable.'
                  : on.length
                    ? on
                        .map((plugin) => `${plugin.label}${plugin.locked ? ' (always on)' : ''}`)
                        .join(', ')
                    : 'No plugins on.'
            }
            openLabel="Manage plugins"
            openName="Manage plugins"
          >
            <PluginsCard agent={agent} />
          </OpenCard>
        )}
        {!coding && <ChannelsCard agent={agent} />}
        {!coding && <ScoreAccessCard agent={agent} />}
      </div>
    </section>
  )
}
