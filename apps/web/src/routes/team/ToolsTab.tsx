import type { AgentDetail } from '@score/contract'
import { useToolAction } from './agent-tab-queries.ts'
import { tabFailure } from './tab-errors.ts'

export function ToolsTab({ agent }: { agent: AgentDetail }) {
  const change = useToolAction(agent.id)
  return (
    <section className="team-card" aria-labelledby="team-tools-heading">
      <h2 id="team-tools-heading">Tools</h2>
      {!agent.tools.length && <p className="team-muted-strong">No tools available.</p>}
      {change.isError && <p role="alert">{tabFailure(change.error, 'change the tool')}</p>}
      <ul className="team-rows">
        {agent.tools.map((tool) => (
          <li key={tool.id}>
            <span>
              {tool.label}
              {tool.kind === 'mcp' && <small> MCP server</small>}
            </span>
            {tool.kind === 'mcp' ? (
              <span className="team-muted">{tool.enabled ? 'On' : 'Off'} · managed in Hermes</span>
            ) : (
              <button
                type="button"
                role="switch"
                className="team-toggle"
                data-enabled={tool.enabled}
                aria-checked={tool.enabled}
                aria-label={`${tool.label} enabled for ${agent.name}`}
                disabled={change.isPending}
                onClick={() => change.mutate({ id: tool.id, enabled: !tool.enabled })}
              />
            )}
          </li>
        ))}
        <li>
          <span>Helpers they can spawn</span>
          <strong>{agent.helpersMax === null ? 'Not set' : `Up to ${agent.helpersMax}`}</strong>
        </li>
      </ul>
    </section>
  )
}
