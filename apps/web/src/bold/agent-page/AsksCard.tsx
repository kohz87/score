import type { AgentDetail } from '@score/contract'
import { usePermissionAction } from '../../routes/settings/rules-queries.ts'

/** "Asks you first before": the rules set to Asks, each a checkbox that can only loosen it back to Allowed. */
export function AsksCard({ agent }: { agent: AgentDetail }) {
  const change = usePermissionAction(agent.id)
  const asks = agent.permissions.filter((permission) => permission.level === 'asks')
  return (
    <section
      className="card bold-up-card"
      id="agent-asks"
      aria-labelledby="agent-asks-title"
      data-protected="block"
    >
      <span className="lab" id="agent-asks-title">
        Asks you first before
      </span>
      {asks.length ? (
        <ul className="bold-asks">
          {asks.map((permission) => (
            <li key={permission.id} style={{ listStyle: 'none' }}>
              <label className="check">
                <input
                  type="checkbox"
                  checked
                  disabled={change.isPending}
                  onChange={(event) =>
                    change.mutate({
                      id: permission.id,
                      level: event.target.checked ? 'asks' : 'allowed',
                    })
                  }
                />
                <span className="grow">{permission.label}</span>
              </label>
            </li>
          ))}
        </ul>
      ) : (
        <p className="small muted">Nothing asks you first right now.</p>
      )}
      {change.isError && <p role="alert">Couldn’t change the permission. Try again.</p>}
      <p className="small muted">Stricter than the team rules is fine; looser isn’t.</p>
    </section>
  )
}
