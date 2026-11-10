import type { AgentDetail } from '@score/contract'
import { usePlugins } from '../../routes/settings/settings-queries.ts'
import { CanUseCard } from '../agent-more/CanUseCard.tsx'
import { PluginsCard } from '../agent-more/PluginsCard.tsx'
import { ChannelsLine } from './ChannelsLine.tsx'
import { OpenCard, useOpenState } from './OpenCard.tsx'
import { ScoreAccessLine } from './ScoreAccessLine.tsx'

/**
 * Tools (mock-up 26): two columns. Left, Can use (the checkboxes are the setting). Right, one line each for Plugins,
 * Reachable on (channels) and Score access; each opens its full card in place.
 */
export function ToolsSection({
  agent,
  coding,
  initialOpen,
}: {
  agent: AgentDetail
  coding: boolean
  initialOpen?: string
}) {
  const [plugins, setPlugins] = useOpenState(initialOpen === 'plugins')
  const list = usePlugins(coding ? undefined : agent.id)
  const on = (list.data ?? []).filter((plugin) => plugin.enabled)
  return (
    <section
      className="bold-agent-section"
      id="agent-section-tools"
      aria-labelledby="agent-section-tools-title"
    >
      <h2 id="agent-section-tools-title">Tools</h2>
      <div className="bold-agent-tools">
        <CanUseCard agent={agent} coding={coding} />
        {!coding && (
          <div className="bold-agent-stack">
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
            <ChannelsLine agent={agent} initialOpen={initialOpen === 'channels'} />
            <ScoreAccessLine agent={agent} initialOpen={initialOpen === 'score-access'} />
          </div>
        )}
      </div>
    </section>
  )
}
