import {
  WORKFLOW_LIMITS,
  type AgentSummary,
  type BranchCondition,
  type WorkflowNode,
} from '@score/contract'
import { useId, useState } from 'react'
import { AgentChip } from '../orchestrations/RunDecisions.tsx'
import { TemplateField } from './TemplateField.tsx'
import {
  addRule,
  connect,
  describeCondition,
  disconnect,
  edgesFrom,
  edgesTo,
  KIND_HELP,
  KIND_LABEL,
  portsOf,
  removeRule,
  renameNode,
  updateNode,
  updateRule,
  type Draft,
} from './workflow-model.ts'
import type { EditorIssue } from './workflow-validation.ts'

// The inspector of the node selected in the editor: its settings, its connections (the keyboard and screen reader way
// to connect, next to dragging on the canvas) and the validation problems that concern it.

type Commit = (next: Draft, coalesce?: string) => void

function IssueLines({ issues }: { issues: EditorIssue[] }) {
  if (issues.length === 0) return null
  return (
    <ul className="wf-issues wf-issues--inline" aria-label="Problems with this step">
      {issues.map((issue, index) => (
        <li key={`${issue.code}-${index}`} className={`wf-issue wf-issue--${issue.severity}`}>
          <strong>{issue.severity === 'error' ? 'Problem' : 'Warning'}</strong>
          <span>
            {issue.message}
            <small>{issue.help}</small>
          </span>
        </li>
      ))}
    </ul>
  )
}

function IdField({ draft, node, commit }: { draft: Draft; node: WorkflowNode; commit: Commit }) {
  const [text, setText] = useState(node.id)
  const [error, setError] = useState<string | null>(null)
  const id = useId()
  function apply() {
    if (text === node.id) return
    if (!/^[a-z][a-z0-9_-]{0,31}$/.test(text))
      return setError(
        'Use lowercase letters, digits, - and _, starting with a letter (32 at most).',
      )
    if (draft.nodes.some((other) => other.id === text))
      return setError('Another step has that name.')
    setError(null)
    commit(renameNode(draft, node.id, text))
  }
  return (
    <div className="orch-field">
      <label htmlFor={id}>
        <span>Reference name</span>
      </label>
      <input
        id={id}
        className="orch-mono"
        value={text}
        aria-invalid={error ? true : undefined}
        onChange={(event) => setText(event.target.value)}
        onBlur={apply}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            apply()
          }
        }}
      />
      <small className="orch-muted">
        Later steps read this step as <code>{`{{nodes.${node.id}.output}}`}</code>.
      </small>
      {error && (
        <small role="alert" className="orch-error">
          {error}
        </small>
      )}
    </div>
  )
}

function Connections({
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

/** A dollar amount typed as text: "0." is on its way to "0.25", so the text is kept apart from the number. */
function EstimateField({
  value,
  onChange,
}: {
  value: number | undefined
  onChange: (value: number | undefined) => void
}) {
  const [text, setText] = useState(value === undefined ? '' : String(value))
  const number = Number(text)
  const bad = text.trim() !== '' && !(number > 0 && number <= 1000)
  return (
    <label className="orch-field">
      <span>Estimate (USD, optional)</span>
      <input
        inputMode="decimal"
        value={text}
        aria-invalid={bad || undefined}
        onChange={(event) => {
          const next = event.target.value
          setText(next)
          const parsed = Number(next)
          if (next.trim() === '') onChange(undefined)
          else if (parsed > 0 && parsed <= 1000) onChange(parsed)
        }}
      />
      <small className={bad ? 'orch-error' : 'orch-muted'}>
        {bad
          ? 'Enter an amount above 0 and up to 1000.'
          : 'Reserved against the budget before it starts.'}
      </small>
    </label>
  )
}

function conditionKey(when: BranchCondition): string {
  return when.kind === 'verdict'
    ? `verdict:${when.is}`
    : when.kind === 'outcome'
      ? `outcome:${when.is}`
      : 'output_contains'
}

function conditionFrom(key: string, current: BranchCondition): BranchCondition {
  if (key === 'verdict:passed') return { kind: 'verdict', is: 'passed' }
  if (key === 'verdict:changes_requested') return { kind: 'verdict', is: 'changes_requested' }
  if (key === 'outcome:succeeded') return { kind: 'outcome', is: 'succeeded' }
  if (key === 'outcome:failed') return { kind: 'outcome', is: 'failed' }
  return { kind: 'output_contains', text: current.kind === 'output_contains' ? current.text : '' }
}

export function NodeInspector({
  draft,
  node,
  agents,
  issues,
  commit,
  onDelete,
  announce,
}: {
  draft: Draft
  node: WorkflowNode
  agents: AgentSummary[]
  issues: EditorIssue[]
  commit: Commit
  onDelete: () => void
  announce: (message: string) => void
}) {
  const hermes = agents.filter((agent) => !agent.runtime || agent.runtime === 'hermes')
  const patch = (change: Partial<WorkflowNode>, coalesce?: string) =>
    commit(updateNode(draft, node.id, change), coalesce)
  const agentNodes = draft.nodes.filter((other) => other.kind === 'agent')
  const issueFor = (field: string) => issues.some((issue) => issue.field === field)

  return (
    <div className="wf-inspector" data-node-id={node.id}>
      <header>
        <h3>{node.label || node.id}</h3>
        <p className="orch-muted">
          {KIND_LABEL[node.kind]}. {KIND_HELP[node.kind]}
        </p>
      </header>

      <IssueLines issues={issues} />

      <label className="orch-field">
        <span>Title</span>
        <input
          value={node.label}
          maxLength={WORKFLOW_LIMITS.labelChars}
          aria-invalid={issueFor('label') || node.label === '' ? true : undefined}
          onChange={(event) => patch({ label: event.target.value }, `label:${node.id}`)}
        />
      </label>
      <IdField key={node.id} draft={draft} node={node} commit={commit} />

      {node.kind === 'agent' && (
        <>
          <label className="orch-field">
            <span>Agent</span>
            <select
              value={node.agentId}
              aria-invalid={node.agentId === '' ? true : undefined}
              onChange={(event) => patch({ agentId: event.target.value })}
            >
              {node.agentId === '' && <option value="">Choose an agent…</option>}
              {node.agentId !== '' && !hermes.some((agent) => agent.id === node.agentId) && (
                <option value={node.agentId}>{node.agentId} (not on this team)</option>
              )}
              {hermes.map((agent) => (
                <option key={agent.id} value={agent.id}>
                  {agent.name}
                </option>
              ))}
            </select>
            {node.agentId !== '' && <AgentChip agentId={node.agentId} agents={agents} />}
          </label>
          <TemplateField
            label="Instruction"
            value={node.instruction}
            onChange={(value) => patch({ instruction: value }, `instruction:${node.id}`)}
            draft={draft}
            nodeId={node.id}
            rows={8}
            invalid={issueFor('instruction') || node.instruction.trim() === ''}
          />
          <div className="orch-row">
            <label className="orch-field">
              <span>Retries</span>
              <select
                value={node.retries}
                onChange={(event) => patch({ retries: Number(event.target.value) })}
              >
                {[0, 1, 2].map((n) => (
                  <option key={n} value={n}>
                    {n === 0 ? 'None' : n === 1 ? 'Once' : 'Twice'}
                  </option>
                ))}
              </select>
              <small className="orch-muted">
                Runs up to {node.retries + 1} {node.retries === 0 ? 'time' : 'times'}.
              </small>
            </label>
            <EstimateField
              key={node.id}
              value={node.estimateUsd}
              onChange={(value) => {
                const next = { ...node }
                if (value === undefined) delete next.estimateUsd
                else next.estimateUsd = value
                commit(
                  { ...draft, nodes: draft.nodes.map((n) => (n.id === node.id ? next : n)) },
                  `estimate:${node.id}`,
                )
              }}
            />
          </div>
          <fieldset className="orch-field">
            <legend>If it fails</legend>
            <label className="orch-check">
              <input
                type="radio"
                name={`fail-${node.id}`}
                checked={node.onFailure === 'fail_run'}
                onChange={() => patch({ onFailure: 'fail_run' })}
              />
              <span>Failing stops the run</span>
            </label>
            <label className="orch-check">
              <input
                type="radio"
                name={`fail-${node.id}`}
                checked={node.onFailure === 'route'}
                onChange={() => patch({ onFailure: 'route' })}
              />
              <span>Route a failure to its own path (connect “when it fails”)</span>
            </label>
          </fieldset>
        </>
      )}

      {node.kind === 'gate' && (
        <>
          <TemplateField
            label="Question"
            value={node.question}
            onChange={(value) => patch({ question: value }, `question:${node.id}`)}
            draft={draft}
            nodeId={node.id}
            rows={4}
            invalid={issueFor('question') || node.question.trim() === ''}
          />
          <fieldset className="orch-field">
            <legend>If you reject</legend>
            <label className="orch-check">
              <input
                type="radio"
                name={`reject-${node.id}`}
                checked={node.onReject === 'stop_run'}
                onChange={() => patch({ onReject: 'stop_run' })}
              />
              <span>Rejecting stops the run</span>
            </label>
            <label className="orch-check">
              <input
                type="radio"
                name={`reject-${node.id}`}
                checked={node.onReject === 'route'}
                onChange={() => patch({ onReject: 'route' })}
              />
              <span>Route a rejection to its own path (connect “when rejected”)</span>
            </label>
          </fieldset>
        </>
      )}

      {node.kind === 'branch' && (
        <>
          <label className="orch-field">
            <span>Looks at</span>
            <select
              value={node.subject}
              aria-invalid={node.subject === '' ? true : undefined}
              onChange={(event) => patch({ subject: event.target.value })}
            >
              {node.subject === '' && <option value="">Choose an earlier agent step…</option>}
              {agentNodes.map((other) => (
                <option key={other.id} value={other.id}>
                  {other.label}
                </option>
              ))}
            </select>
          </label>
          <fieldset className="orch-field wf-rules">
            <legend>Rules, first match wins</legend>
            {node.rules.map((rule, index) => (
              <div key={rule.id} className="wf-rule">
                <span className="wf-rule__n">{index + 1}.</span>
                <select
                  aria-label={`Rule ${index + 1} condition`}
                  value={conditionKey(rule.when)}
                  onChange={(event) =>
                    commit(
                      updateRule(
                        draft,
                        node.id,
                        rule.id,
                        conditionFrom(event.target.value, rule.when),
                      ),
                    )
                  }
                >
                  <option value="verdict:passed">the verdict is: passed</option>
                  <option value="verdict:changes_requested">
                    the verdict is: changes requested
                  </option>
                  <option value="outcome:succeeded">the step succeeded</option>
                  <option value="outcome:failed">the step failed</option>
                  <option value="output_contains">the output contains…</option>
                </select>
                {rule.when.kind === 'output_contains' && (
                  <input
                    aria-label={`Rule ${index + 1} text`}
                    value={rule.when.text}
                    maxLength={WORKFLOW_LIMITS.branchTextChars}
                    onChange={(event) =>
                      commit(
                        updateRule(draft, node.id, rule.id, {
                          kind: 'output_contains',
                          text: event.target.value,
                        }),
                        `rule:${rule.id}`,
                      )
                    }
                  />
                )}
                <button
                  type="button"
                  className="wf-link"
                  disabled={node.rules.length <= 1}
                  aria-label={`Remove rule ${index + 1} (${describeCondition(rule.when)})`}
                  onClick={() => commit(removeRule(draft, node.id, rule.id))}
                >
                  Remove
                </button>
              </div>
            ))}
            <div className="wf-rule wf-rule--default">
              <span className="wf-rule__n">else</span>
              <span>otherwise (always needed)</span>
            </div>
            <button
              type="button"
              disabled={node.rules.length >= WORKFLOW_LIMITS.maxBranchRules}
              onClick={() => commit(addRule(draft, node.id))}
            >
              Add a rule
            </button>
            {node.rules.some((rule) => rule.when.kind === 'output_contains') && (
              <small className="orch-muted">
                “Output contains” looks at the saved output, which may be shortened, and ignores
                capitals. It is a hint to route on, never an approval.
              </small>
            )}
            {node.rules.some((rule) => rule.when.kind === 'verdict') && (
              <small className="orch-muted">
                A verdict exists only if the agent ends its reply with a score-verdict block.
                Otherwise the “otherwise” path is taken.
              </small>
            )}
          </fieldset>
        </>
      )}

      <Connections draft={draft} node={node} commit={commit} announce={announce} />

      <div className="orch-actions wf-danger-zone">
        <button
          type="button"
          className="orch-danger"
          onClick={() => {
            onDelete()
            announce(`Deleted ${node.label}.`)
          }}
        >
          Delete {node.label || 'this step'}
        </button>
      </div>
    </div>
  )
}
