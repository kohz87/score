import type { AgentDetail, AgentSummary } from '@score/contract'
import { Link } from 'react-router'

const permissionLabels = { allowed: 'Allowed', asks: 'Asks you', never: 'Never' } as const

export function AgentOverview({
  agent,
  agents,
  selectTab,
}: {
  agent: AgentDetail
  agents: AgentSummary[]
  selectTab: (tab: string, file?: 'SOUL.md' | 'AGENTS.md') => void
}) {
  const manager = agents.find((item) => item.id === agent.reportsTo)
  return (
    <div className="team-grid">
      <section className="team-card team-personality" aria-labelledby="team-personality">
        <div className="team-personality-text">
          <div className="team-card-heading">
            <h2 id="team-personality">Personality</h2>
            <span className="team-muted">From {agent.personality.source}</span>
          </div>
          <p>{agent.personality.excerpt || 'No personality excerpt available.'}</p>
          <button
            type="button"
            className="team-text-action"
            onClick={() => selectTab('Personality', 'SOUL.md')}
          >
            Edit personality
          </button>
        </div>
        <dl className="team-facts">
          <div>
            <dt>Reports to</dt>
            <dd>
              {manager ? (
                <Link to={`/team/${encodeURIComponent(manager.id)}`}>{manager.name}</Link>
              ) : (
                (agent.reportsTo ?? 'No one')
              )}
            </dd>
          </div>
          <div>
            <dt>Works in</dt>
            <dd>{agent.worksIn ? <code>{agent.worksIn}</code> : 'Not set'}</dd>
          </div>
          <div>
            <dt>Operating rules</dt>
            <dd>
              {agent.rulesFile ?? 'Not set'}{' '}
              <button
                type="button"
                className="team-text-action"
                onClick={() => selectTab('Personality', 'AGENTS.md')}
              >
                {agent.rulesFile ? 'Edit rules' : 'Create rules'}
              </button>
            </dd>
          </div>
        </dl>
      </section>

      <section className="team-card" aria-labelledby="team-model">
        <h2 id="team-model">Model</h2>
        <p className="team-model-name">{agent.model?.label ?? 'Model unavailable'}</p>
        {agent.model && (
          <p className="team-muted-strong">
            {agent.model.via ? `Through ${agent.model.via}.` : 'Provider unavailable.'}
            {agent.model.fallback
              ? ` Falls back to ${agent.model.fallback} if it's unavailable.`
              : ' No fallback configured.'}
          </p>
        )}
        <button type="button" className="team-text-action" onClick={() => selectTab('Model')}>
          Change model
        </button>
      </section>

      <section className="team-card" aria-labelledby="team-skills">
        <div className="team-card-heading">
          <h2 id="team-skills">Skills</h2>
          <button type="button" className="team-text-action" onClick={() => selectTab('Skills')}>
            Browse the hub
          </button>
        </div>
        {agent.skills.length ? (
          <ul className="team-skills">
            {agent.skills.map((skill) => (
              <li key={skill.name} data-enabled={skill.enabled}>
                {skill.name}
                {!skill.enabled && ' · Disabled'}
              </li>
            ))}
          </ul>
        ) : (
          <p className="team-muted-strong">No skills configured.</p>
        )}
      </section>

      <section className="team-card" aria-labelledby="team-memory">
        <div className="team-card-heading">
          <h2 id="team-memory">Memory</h2>
          <button type="button" className="team-text-action" onClick={() => selectTab('Memory')}>
            Search all
          </button>
        </div>
        {agent.memory.map((memory) => (
          <p className="team-memory" key={memory.id}>
            {memory.text}
            <span>{memory.source}</span>
          </p>
        ))}
        {!agent.memory.length && <p className="team-muted-strong">No memories yet.</p>}
      </section>

      <section className="team-card" aria-labelledby="team-tools">
        <h2 id="team-tools">Tools</h2>
        <ul className="team-rows">
          {agent.tools.map((tool) => (
            <li key={tool.id}>
              <span>
                {tool.label}
                {tool.kind === 'mcp' && <small> MCP server</small>}
              </span>
              <span
                className="team-toggle"
                data-enabled={tool.enabled}
                role="img"
                aria-label={tool.enabled ? 'Enabled' : 'Disabled'}
              />
            </li>
          ))}
          <li>
            <span>Helpers they can spawn</span>
            <strong>{agent.helpersMax === null ? 'Not set' : `Up to ${agent.helpersMax}`}</strong>
          </li>
        </ul>
      </section>

      <section className="team-card" aria-labelledby="team-routines">
        <div className="team-card-heading">
          <h2 id="team-routines">Routines</h2>
          <button type="button" className="team-text-action" onClick={() => selectTab('Routines')}>
            New routine
          </button>
        </div>
        {agent.routines.map((routine) => (
          <div className="team-routine" key={routine.id}>
            <span className="team-schedule">{routine.schedule}</span>
            <div>
              <strong>
                {routine.title}
                {!routine.enabled && ' · Disabled'}
              </strong>
              <p className="team-muted-strong">{routine.description}</p>
            </div>
          </div>
        ))}
        {!agent.routines.length && <p className="team-muted-strong">No routines configured.</p>}
      </section>

      <section className="team-card" aria-labelledby="team-permissions">
        <h2 id="team-permissions">Permissions</h2>
        <ul className="team-rows">
          {agent.permissions.map((permission) => (
            <li key={permission.id}>
              <span>{permission.label}</span>
              <strong className={`team-permission team-permission-${permission.level}`}>
                {permissionLabels[permission.level]}
              </strong>
            </li>
          ))}
        </ul>
        {!agent.permissions.length && (
          <p className="team-muted-strong">No permissions available.</p>
        )}
      </section>
    </div>
  )
}
