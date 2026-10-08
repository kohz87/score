import { useState } from 'react'
import type { AgentSummary } from '@score/contract'
import { ApiError } from '../../data/api.ts'
import { saveTheme, readTheme, themeChoices, type ThemeChoice } from '../../data/theme.ts'
import { usePluginToggle, usePlugins } from './settings-queries.ts'

const themeLabels: Record<ThemeChoice, string> = { light: 'Light', dark: 'Dark', system: 'System' }

function ThemeCard() {
  const [theme, setTheme] = useState<ThemeChoice>(readTheme)
  return (
    <div className="plugins-card plugins-theme">
      <span className="plugins-card-name" id="plugins-theme-label">
        Theme
      </span>
      <div
        role="radiogroup"
        aria-labelledby="plugins-theme-label"
        className="plugins-theme-choices"
      >
        {themeChoices.map((choice) => (
          <button
            key={choice}
            type="button"
            role="radio"
            aria-checked={theme === choice}
            className="plugins-theme-choice"
            data-theme-choice={choice}
            onClick={() => {
              setTheme(choice)
              saveTheme(choice)
            }}
          >
            <span className="plugins-theme-swatch" data-choice={choice} aria-hidden="true" />
            {themeLabels[choice]}
          </button>
        ))}
      </div>
    </div>
  )
}

function PluginList({ agent }: { agent: AgentSummary }) {
  const plugins = usePlugins(agent.id)
  const toggle = usePluginToggle(agent.id)
  const error =
    toggle.error instanceof ApiError
      ? toggle.error.message
      : toggle.error
        ? 'Could not change the plugin.'
        : null
  return (
    <>
      {plugins.status === 'pending' && <p role="status">Loading plugins…</p>}
      {plugins.status === 'error' && (
        <p role="alert">Could not load plugins for {agent.name}. Check that Hermes is reachable.</p>
      )}
      {error && <p role="alert">{error}</p>}
      {plugins.data && plugins.data.length === 0 && (
        <p className="settings-muted">No plugins installed for {agent.name}.</p>
      )}
      <ul className="plugins-grid">
        {plugins.data?.map((plugin) => (
          <li key={plugin.id} className="plugins-card">
            <span className="plugins-card-text">
              <span className="plugins-card-name">{plugin.label}</span>
              {plugin.locked ? (
                <span className="settings-muted" id={`plugin-note-${plugin.id}`}>
                  Always on: Score needs this plugin to see what {agent.name} does, so it can&apos;t
                  be turned off here.
                </span>
              ) : (
                plugin.description && <span className="settings-muted">{plugin.description}</span>
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
    </>
  )
}

export function PluginsSection({ agents }: { agents: AgentSummary[] }) {
  const [picked, setPicked] = useState('')
  const agent = agents.find((candidate) => candidate.id === picked) ?? agents[0]
  return (
    <section id="plugins" className="settings-card" aria-labelledby="settings-plugins">
      <div>
        <h2 id="settings-plugins">Plugins and look</h2>
        <p className="settings-muted-strong">
          Extensions that add pages, tools or hooks, and how Score looks.
        </p>
      </div>
      <div className="plugins-grid">
        <ThemeCard />
      </div>
      <div className="plugins-picker">
        <h3>Hermes plugins</h3>
        {agent && (
          <select
            className="score-select"
            aria-label="Agent whose plugins to show"
            value={agent.id}
            onChange={(event) => setPicked(event.target.value)}
          >
            {agents.map((candidate) => (
              <option key={candidate.id} value={candidate.id}>
                {candidate.name}
              </option>
            ))}
          </select>
        )}
      </div>
      {agent ? (
        <PluginList key={agent.id} agent={agent} />
      ) : (
        <p className="settings-muted">Add an agent in Team to manage its plugins.</p>
      )}
    </section>
  )
}
