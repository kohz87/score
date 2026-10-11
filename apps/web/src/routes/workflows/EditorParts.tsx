import { WORKFLOW_LIMITS, type AgentSummary, type WorkflowNodeKind } from '@score/contract'
import { AgentGlyph } from '../../components/AgentGlyph.tsx'
import { PALETTE_MIME, type Selection } from './EditorCanvas.tsx'
import {
  addInput,
  KIND_HELP,
  KIND_LABEL,
  outlineOf,
  removeInput,
  renameInput,
  type Draft,
} from './workflow-model.ts'
import type { EditorIssue, IssueIndex } from './workflow-validation.ts'

// The smaller parts of the editor: palette, outline, start inputs and the list of problems.

/** Local nodes first (they are the new idea), then one entry per agent so each shows its glyph. */
export function Palette({
  agents,
  onAdd,
  disabled,
}: {
  agents: AgentSummary[]
  onAdd: (kind: WorkflowNodeKind, agentId?: string) => void
  disabled: boolean
}) {
  const hermes = agents.filter((agent) => !agent.runtime || agent.runtime === 'hermes')
  const drag = (kind: WorkflowNodeKind, agentId = '') => ({
    draggable: !disabled,
    onDragStart: (event: React.DragEvent) => {
      event.dataTransfer.setData(PALETTE_MIME, JSON.stringify({ kind, agentId }))
      event.dataTransfer.effectAllowed = 'copy'
    },
  })
  return (
    <section className="wf-palette" aria-label="Palette">
      <h3>Add to the workflow</h3>
      <p className="orch-muted">
        Click to add (it is connected after the selected step), or drag onto the canvas. Dropping on
        a step connects the new one after it.
      </p>
      <h4>Agent steps</h4>
      <ul>
        {hermes.map((agent) => (
          <li key={agent.id}>
            <button
              type="button"
              className="wf-palette__item"
              disabled={disabled}
              onClick={() => onAdd('agent', agent.id)}
              {...drag('agent', agent.id)}
            >
              <AgentGlyph agent={agent} size="xs" decorative />
              <span>
                <b>{agent.name}</b>
                <small>{KIND_HELP.agent}</small>
              </span>
              <span className="wf-visually-hidden">Add an agent step for {agent.name}</span>
            </button>
          </li>
        ))}
        {hermes.length === 0 && <li className="orch-muted">No agents on the team yet.</li>}
      </ul>
      <h4>Flow control</h4>
      <ul>
        {(['gate', 'branch', 'join', 'end'] as const).map((kind) => (
          <li key={kind}>
            <button
              type="button"
              className="wf-palette__item"
              disabled={disabled}
              onClick={() => onAdd(kind)}
              {...drag(kind)}
            >
              <span className={`wf-palette__shape wf-palette__shape--${kind}`} aria-hidden="true" />
              <span>
                <b>{KIND_LABEL[kind]}</b>
                <small>{KIND_HELP[kind]}</small>
              </span>
              <span className="wf-visually-hidden">
                Add {kind === 'end' ? 'an' : 'a'} {KIND_LABEL[kind].toLowerCase()}
              </span>
            </button>
          </li>
        ))}
      </ul>
    </section>
  )
}

/** Every step in reading order with where each connection goes: the text equivalent of the canvas. */
export function Outline({
  draft,
  issues,
  selected,
  onSelect,
}: {
  draft: Draft
  issues: IssueIndex
  selected: Selection
  onSelect: (selection: Selection) => void
}) {
  const items = outlineOf(draft)
  return (
    <section className="wf-outline" aria-label="Outline">
      <h3>Outline</h3>
      <p className="orch-muted">The same workflow as text: each step and where it leads.</p>
      <ol>
        {items.map((item) => {
          const problems =
            (issues.byNode.get(item.id)?.length ?? 0) +
            draft.edges
              .filter((e) => e.from === item.id)
              .reduce((n, e) => n + (issues.byEdge.get(e.id)?.length ?? 0), 0)
          return (
            <li key={item.id}>
              <button
                type="button"
                className="wf-link wf-outline__node"
                aria-current={
                  selected?.kind === 'node' && selected.id === item.id ? 'true' : undefined
                }
                onClick={() => onSelect({ kind: 'node', id: item.id })}
              >
                {item.title || item.id}
              </button>{' '}
              <span className="orch-muted">
                {KIND_LABEL[item.kind].toLowerCase()}
                {item.root ? ', where it starts' : ''}
              </span>
              {problems > 0 && (
                <strong className="orch-error">
                  {' '}
                  {problems} {problems === 1 ? 'problem' : 'problems'}
                </strong>
              )}
              {item.connections.length > 0 && (
                <ul>
                  {item.connections.map((connection) => (
                    <li key={connection.edgeId}>
                      <button
                        type="button"
                        className="wf-link"
                        aria-current={
                          selected?.kind === 'edge' && selected.id === connection.edgeId
                            ? 'true'
                            : undefined
                        }
                        onClick={() => onSelect({ kind: 'edge', id: connection.edgeId })}
                      >
                        {connection.text}
                      </button>
                    </li>
                  ))}
                </ul>
              )}
              {item.connections.length === 0 && item.kind !== 'end' && (
                <span className="orch-muted"> Goes nowhere yet.</span>
              )}
            </li>
          )
        })}
      </ol>
    </section>
  )
}

/** The values a person types when starting a run; steps read them as `{{inputs.name}}`. */
export function InputsEditor({
  draft,
  commit,
  issues,
}: {
  draft: Draft
  commit: (next: Draft, coalesce?: string) => void
  issues: EditorIssue[]
}) {
  return (
    <section className="wf-inputs-editor" aria-label="Start inputs">
      <h3>Start inputs</h3>
      <p className="orch-muted">
        What you fill in when you start a run. A step reads one with{' '}
        <code>{'{{inputs.name}}'}</code>.
      </p>
      {draft.inputs.map((input, index) => (
        <fieldset key={index} className="wf-input">
          <legend>Input {index + 1}</legend>
          <div className="orch-row">
            <label className="orch-field">
              <span>Name</span>
              <input
                className="orch-mono"
                value={input.name}
                aria-invalid={issues.some((i) => i.code === 'duplicate_input') || undefined}
                onChange={(event) =>
                  commit(renameInput(draft, input.name, event.target.value), `input-name:${index}`)
                }
              />
            </label>
            <label className="orch-field">
              <span>Label</span>
              <input
                value={input.label}
                maxLength={WORKFLOW_LIMITS.inputLabelChars}
                onChange={(event) =>
                  commit(
                    {
                      ...draft,
                      inputs: draft.inputs.map((x, i) =>
                        i === index ? { ...x, label: event.target.value } : x,
                      ),
                    },
                    `input-label:${index}`,
                  )
                }
              />
            </label>
          </div>
          <div className="orch-row">
            <label className="orch-field">
              <span>Longest answer (characters)</span>
              <input
                type="number"
                min={1}
                max={WORKFLOW_LIMITS.inputMaxChars}
                value={input.maxChars}
                onChange={(event) =>
                  commit(
                    {
                      ...draft,
                      inputs: draft.inputs.map((x, i) =>
                        i === index ? { ...x, maxChars: Number(event.target.value) } : x,
                      ),
                    },
                    `input-max:${index}`,
                  )
                }
              />
            </label>
            <label className="orch-check">
              <input
                type="checkbox"
                checked={input.required}
                onChange={(event) =>
                  commit({
                    ...draft,
                    inputs: draft.inputs.map((x, i) =>
                      i === index ? { ...x, required: event.target.checked } : x,
                    ),
                  })
                }
              />
              Required
            </label>
            <button
              type="button"
              className="wf-link"
              aria-label={`Remove input ${input.label || input.name}`}
              onClick={() => commit(removeInput(draft, input.name))}
            >
              Remove
            </button>
          </div>
        </fieldset>
      ))}
      <button
        type="button"
        disabled={draft.inputs.length >= WORKFLOW_LIMITS.maxInputs}
        onClick={() => commit(addInput(draft))}
      >
        Add an input
      </button>
    </section>
  )
}

/** Every problem, each saying which node or connection it is about. Clicking one selects it. */
export function IssueList({
  issues,
  draft,
  onSelect,
  checking,
  headline,
}: {
  issues: EditorIssue[]
  draft: Draft
  onSelect: (selection: Selection) => void
  checking: boolean
  headline: string
}) {
  const nodeLabel = (id: string | null) =>
    id ? (draft.nodes.find((node) => node.id === id)?.label ?? id) : null
  return (
    <section className="wf-problems" aria-label="Problems" aria-busy={checking}>
      <h3>
        Problems <small className="orch-muted">{headline}</small>
      </h3>
      {issues.length === 0 ? (
        <p className="orch-muted">Nothing to fix.</p>
      ) : (
        <ul className="wf-issues">
          {issues.map((issue, index) => {
            const edge = issue.edgeId ? draft.edges.find((e) => e.id === issue.edgeId) : undefined
            const where = edge
              ? `Connection from ${nodeLabel(edge.from)} to ${nodeLabel(edge.to)}`
              : nodeLabel(issue.nodeId)
            return (
              <li
                key={`${issue.code}-${issue.nodeId}-${issue.edgeId}-${index}`}
                className={`wf-issue wf-issue--${issue.severity}`}
              >
                <strong>{issue.severity === 'error' ? 'Problem' : 'Warning'}</strong>
                <span>
                  {where && (
                    <button
                      type="button"
                      className="wf-link"
                      onClick={() =>
                        onSelect(
                          edge
                            ? { kind: 'edge', id: edge.id }
                            : { kind: 'node', id: issue.nodeId! },
                        )
                      }
                    >
                      {where}
                    </button>
                  )}
                  {where ? ': ' : ''}
                  {issue.message}
                  <small>{issue.help}</small>
                </span>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
