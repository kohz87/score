import type { AgentDetail } from '@score/contract'
import { ApiError } from '../../data/api.ts'
import { usePluginToggle, usePlugins } from '../settings/settings-queries.ts'
import '../../components/plugin-cards.css'

/** Hermes plugins are per profile, so they live on the agent's own page. */
function PluginList({ agent }: { agent: Pick<AgentDetail, 'id' | 'name'> }) {
  const plugins = usePlugins(agent.id)
  const toggle = usePluginToggle(agent.id)
  const error =
    toggle.error instanceof ApiError
      ? toggle.error.message
      : toggle.error
        ? 'Couldn’t change the plugin.'
        : null
  return (
    <>
      {plugins.status === 'pending' && <p role="status">Loading plugins…</p>}
      {plugins.status === 'error' && (
        <p role="alert">Couldn’t load plugins for {agent.name}. Check that Hermes is reachable.</p>
      )}
      {error && <p role="alert">{error}</p>}
      {plugins.data && plugins.data.length === 0 && (
        <p className="team-muted">No plugins installed for {agent.name}.</p>
      )}
      <ul className="plugins-grid">
        {plugins.data?.map((plugin) => (
          <li key={plugin.id} className="plugins-card">
            <span className="plugins-card-text">
              <span className="plugins-card-name">{plugin.label}</span>
              {plugin.locked ? (
                <span className="team-muted" id={`plugin-note-${plugin.id}`}>
                  Always on: Score needs this plugin to see what {agent.name} does, so it can’t be
                  turned off here.
                </span>
              ) : (
                plugin.description && <span className="team-muted">{plugin.description}</span>
              )}
            </span>
            <button
              type="button"
              role="switch"
              className="plugin-toggle"
              data-enabled={plugin.enabled}
              aria-checked={plugin.enabled}
              aria-label={`${plugin.label} for ${agent.name}`}
              {...(plugin.locked ? { 'aria-describedby': `plugin-note-${plugin.id}` } : {})}
              disabled={plugin.locked || toggle.isPending}
              onClick={() => toggle.mutate({ id: plugin.id, enabled: !plugin.enabled })}
            />
          </li>
        ))}
      </ul>
      {plugins.data && plugins.data.length > 0 && (
        <p className="team-muted" id="plugins-timing">
          Saved for {agent.name}. A running gateway keeps the plugins it already loaded, so a change
          takes effect on its next session or after a gateway restart.
        </p>
      )}
    </>
  )
}

export function PluginsTab({ agent }: { agent: Pick<AgentDetail, 'id' | 'name'> }) {
  return (
    <section className="team-card" aria-labelledby="team-plugins-heading">
      <h2 id="team-plugins-heading">Plugins</h2>
      <p className="team-muted-strong">
        Extensions that add pages, tools or hooks for {agent.name}.
      </p>
      <PluginList agent={agent} />
    </section>
  )
}
