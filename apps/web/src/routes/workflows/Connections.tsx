import type { WorkflowNode } from '@score/contract'
import {
  connect,
  disconnect,
  edgesFrom,
  edgesTo,
  KIND_LABEL,
  portsOf,
  type Draft,
} from './workflow-model.ts'
import type { Commit } from './node-inspector-types.ts'

export function Connections({
  draft,
  node,
  commit,
  announce,
}: {
  draft: Draft
  node: WorkflowNode
  commit: Commit
  announce: (message: string) => void
}) {
  const ports = portsOf(node)
  const outgoing = edgesFrom(draft, node.id)
  const incoming = edgesTo(draft, node.id)
  const title = (id: string) => draft.nodes.find((n) => n.id === id)?.label ?? id
  return (
    <section aria-label="Connections" className="wf-connections">
      <h4>Connections</h4>
      {ports.length === 0 && <p className="orch-muted">An end has nothing after it.</p>}
      {ports.map((port) => {
        const edges = outgoing.filter((edge) => edge.port === port.id)
        const targets = draft.nodes.filter(
          (other) => other.id !== node.id && !edges.some((edge) => edge.to === other.id),
        )
        return (
          <div key={port.id} className="wf-port">
            <div className="wf-port__head">
              <strong>{port.label}</strong>
              {edges.length === 0 && <span className="orch-muted"> goes nowhere yet</span>}
            </div>
            {edges.length > 0 && (
              <ul>
                {edges.map((edge) => (
                  <li key={edge.id}>
                    <span>goes to {title(edge.to)}</span>
                    <button
                      type="button"
                      className="wf-link"
                      aria-label={`Remove the connection from ${node.label} (${port.label}) to ${title(edge.to)}`}
                      onClick={() => {
                        commit(disconnect(draft, edge.id))
                        announce(`Removed the connection to ${title(edge.to)}.`)
                      }}
                    >
                      Remove
                    </button>
                  </li>
                ))}
              </ul>
            )}
            <label className="wf-port__add">
              <span className="wf-visually-hidden">
                Connect {node.label} ({port.label}) to
              </span>
              <select
                value=""
                disabled={targets.length === 0}
                aria-label={`Connect ${node.label} (${port.label}) to`}
                onChange={(event) => {
                  const to = event.target.value
                  if (!to) return
                  const result = connect(draft, node.id, port.id, to)
                  if ('error' in result) announce(result.error)
                  else {
                    commit(result.draft)
                    announce(`Connected ${node.label} (${port.label}) to ${title(to)}.`)
                  }
                }}
              >
                <option value="">Connect to…</option>
                {targets.map((target) => (
                  <option key={target.id} value={target.id}>
                    {target.label} ({KIND_LABEL[target.kind].toLowerCase()})
                  </option>
                ))}
              </select>
            </label>
          </div>
        )
      })}
      {incoming.length > 0 && (
        <p className="orch-muted wf-incoming">
          Comes from {incoming.map((edge) => title(edge.from)).join(', ')}.
        </p>
      )}
    </section>
  )
}
