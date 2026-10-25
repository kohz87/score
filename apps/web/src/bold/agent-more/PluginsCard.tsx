import type { AgentDetail } from '@score/contract'
import { ApiError } from '../../data/api.ts'
import { usePluginToggle, usePlugins } from '../../routes/settings/settings-queries.ts'
import { Fail, Loading, MoreCard, useFoldedList } from './MoreCard.tsx'

export function PluginsCard({ agent }: { agent: AgentDetail }) {
  const plugins = usePlugins(agent.id)
  const toggle = usePluginToggle(agent.id)
  const list = useFoldedList(`plugins:${agent.id}`, plugins.data ?? [], 8)
  return (
    <MoreCard id="agent-plugins" title="Plugins">
      {plugins.isPending && <Loading what="plugins" />}
      {plugins.isError && <Fail>Couldn’t load plugins. Check that Hermes is reachable.</Fail>}
      {toggle.isError && (
        <Fail>
          {toggle.error instanceof ApiError ? toggle.error.message : 'Couldn’t change the plugin.'}
        </Fail>
      )}
      {plugins.data && !plugins.data.length && <p className="small muted">No plugins installed.</p>}
      <div id={list.id} className="bold-fold-list">
        {list.shown.map((plugin) => (
          <label className="check" key={plugin.id}>
            <input
              type="checkbox"
              checked={plugin.enabled}
              disabled={plugin.locked || toggle.isPending}
              onChange={() => toggle.mutate({ id: plugin.id, enabled: !plugin.enabled })}
            />
            <span>
              {plugin.label}
              {plugin.locked && (
                <span className="small muted"> Always on: Score needs it to see what it does.</span>
              )}
            </span>
          </label>
        ))}
      </div>
      {list.toggle}
      {plugins.data && plugins.data.length > 0 && (
        <span className="small muted">
          A change takes effect on its next session or after a gateway restart.
        </span>
      )}
    </MoreCard>
  )
}
