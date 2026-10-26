import type { AgentSummary, BranchCondition, WorkflowNode } from '@score/contract'
import { AgentGlyph } from '../components/AgentGlyph.tsx'
import { runtimeLabel } from '../components/runtime-label.ts'
import { TemplateField } from '../routes/workflows/TemplateField.tsx'
import { addRule, removeRule, updateRule, type Draft } from '../routes/workflows/workflow-model.ts'
import { TrashIcon } from './BoldIcons.tsx'
import {
  RECIPE_STEP_LABEL,
  RECIPE_STEP_MARK,
  setFailureMode,
  setRejectMode,
  targetStepLabel,
  type RecipeAnalysis,
  type RecipeRow,
} from './recipe-model.ts'

// PLAN 11.10d / 2.8.0: the recipe as a list of steps ("As text"), and the step settings that go with it. Split out of
// BoldRecipes.tsx; the page and its graph live there.

const AGENT_KINDS = new Set(['hermes', 'claude-code', 'codex'])

export type ConditionKey =
  | 'verdict:passed'
  | 'verdict:changes_requested'
  | 'outcome:succeeded'
  | 'outcome:failed'
  | 'output_contains'

function conditionKey(when: BranchCondition): ConditionKey {
  if (when.kind === 'verdict') return `verdict:${when.is}`
  if (when.kind === 'outcome') return `outcome:${when.is}`
  return 'output_contains'
}

function conditionFrom(key: ConditionKey, current: BranchCondition): BranchCondition {
  if (key === 'verdict:passed') return { kind: 'verdict', is: 'passed' }
  if (key === 'verdict:changes_requested') return { kind: 'verdict', is: 'changes_requested' }
  if (key === 'outcome:succeeded') return { kind: 'outcome', is: 'succeeded' }
  if (key === 'outcome:failed') return { kind: 'outcome', is: 'failed' }
  return { kind: 'output_contains', text: current.kind === 'output_contains' ? current.text : '' }
}

function refusalsFor(runtime: AgentSummary['runtime']): boolean {
  return runtime !== undefined && runtime !== null && !AGENT_KINDS.has(runtime)
}

export function RecipeStepRow({
  row,
  analysis,
  agents,
  editable,
  selected,
  moveProblems,
  onSelect,
  onMove,
  onRemove,
  onTarget,
}: {
  row: RecipeRow
  analysis: RecipeAnalysis
  agents: AgentSummary[]
  editable: boolean
  selected: boolean
  moveProblems: { up: string | null; down: string | null }
  onSelect: () => void
  onMove: (direction: -1 | 1) => void
  onRemove: () => void
  onTarget: (nodeId: string, port: string, target: string | null) => void
}) {
  const node = row.node
  const label = node.label || node.id
  const agent = node.kind === 'agent' ? agents.find((item) => item.id === node.agentId) : undefined
  const incoming = row.incoming
    .map((edge) => analysis.order.find((item) => item.id === edge.from)?.label || edge.from)
    .join(', ')
  return (
    <li className={`bold-recipes-row${selected ? ' sel' : ''}`} data-recipe-step={node.id}>
      <div className="bold-recipes-rowmain">
        <button
          type="button"
          className={`bold-step${selected ? ' sel' : ''}`}
          aria-current={selected ? 'true' : undefined}
          onClick={onSelect}
        >
          <span className="mono small muted">{row.index + 1}</span>
          {agent ? (
            <AgentGlyph agent={agent} size="xs" decorative />
          ) : node.kind === 'agent' ? (
            <span className="bold-step-mark bold-step-mark--missing" aria-hidden="true">
              ?
            </span>
          ) : (
            <span className="bold-step-mark" aria-hidden="true">
              {RECIPE_STEP_MARK[node.kind]}
            </span>
          )}
          <span className="grow bold-step-copy">
            <b>{label}</b>
            <span className="small muted">
              {RECIPE_STEP_LABEL[node.kind]}
              {node.kind === 'agent'
                ? ` · ${node.agentId || 'no agent'} · retries ${node.retries}`
                : ''}
            </span>
            {node.kind === 'join' && (
              <span className="small muted">Waits for {incoming || 'nothing yet'}.</span>
            )}
            {node.kind === 'branch' && (
              <span className="small muted">
                Looks at{' '}
                {analysis.order.find((item) => item.id === node.subject)?.label ||
                  node.subject ||
                  'no step yet'}
                .
              </span>
            )}
          </span>
        </button>
        <div className="bold-recipes-rowactions">
          <button
            type="button"
            className="icon-btn sm"
            data-move="up"
            aria-label={`Move ${label} up`}
            title={moveProblems.up ?? `Move ${label} up`}
            disabled={!editable || moveProblems.up !== null}
            onClick={() => onMove(-1)}
          >
            ↑
          </button>
          <button
            type="button"
            className="icon-btn sm"
            data-move="down"
            aria-label={`Move ${label} down`}
            title={moveProblems.down ?? `Move ${label} down`}
            disabled={!editable || moveProblems.down !== null}
            onClick={() => onMove(1)}
          >
            ↓
          </button>
          <button
            type="button"
            className="icon-btn sm bold-recipes-remove"
            aria-label={`Remove ${label}`}
            disabled={!editable}
            onClick={onRemove}
          >
            <TrashIcon />
          </button>
        </div>
      </div>
      {node.kind === 'branch' && row.routes.length > 0 && (
        <div className="bold-recipes-routes">
          {row.routes.map((route) => {
            const value = route.edges[0]?.to ?? ''
            const unknown = value && !analysis.order.some((node) => node.id === value)
            return (
              <label key={route.port} className="bold-recipes-route">
                <span>{route.label} →</span>
                <select
                  aria-label={`${label}: ${route.label} goes to`}
                  value={value}
                  disabled={!editable}
                  onChange={(event) => onTarget(node.id, route.port, event.target.value || null)}
                >
                  <option value="">Not connected</option>
                  {unknown && <option value={value}>Missing step {value}</option>}
                  {analysis.order
                    .filter((target) => target.id !== node.id)
                    .map((target) => (
                      <option key={target.id} value={target.id}>
                        {targetStepLabel(analysis, target.id)}
                      </option>
                    ))}
                </select>
              </label>
            )
          })}
        </div>
      )}
    </li>
  )
}

export function RecipeInspector({
  row,
  analysis,
  draft,
  agents,
  editable,
  commit,
  patch,
  point,
}: {
  row: RecipeRow
  analysis: RecipeAnalysis
  draft: Draft
  agents: AgentSummary[]
  editable: boolean
  commit: (next: Draft, coalesce?: string) => void
  patch: (change: Partial<WorkflowNode>, coalesce?: string) => void
  point: (port: string, target: string | null) => void
}) {
  const node = row.node
  const agentNodes = draft.nodes.filter((item) => item.kind === 'agent')
  const picked =
    node.kind === 'agent' ? agents.find((agent) => agent.id === node.agentId) : undefined
  const codingNote =
    picked?.runtime === 'claude-code' || picked?.runtime === 'codex'
      ? `${runtimeLabel(picked.runtime)} works on this computer, in its own workspace. Starting the run asks you to accept what it can read.`
      : null
  const doneRoute = row.routes.find((route) => route.port === 'ok')
  const failRoute = row.routes.find((route) => route.port === 'failed')
  const rejectRoute = row.routes.find((route) => route.port === 'rejected')
  return (
    <fieldset className="bold-recipes-fields" disabled={!editable}>
      <b>Step {row.index + 1}</b>
      <label className="orch-field">
        <span>Title</span>
        <input
          value={node.label}
          maxLength={80}
          disabled={!editable}
          onChange={(event) => patch({ label: event.target.value }, `label:${node.id}`)}
        />
      </label>

      {node.kind === 'agent' && (
        <>
          <label className="orch-field">
            <span>Agent</span>
            <select
              value={node.agentId}
              disabled={!editable}
              onChange={(event) => patch({ agentId: event.target.value })}
            >
              {node.agentId === '' && <option value="">Choose an agent…</option>}
              {node.agentId !== '' && !agents.some((agent) => agent.id === node.agentId) && (
                <option value={node.agentId}>{node.agentId} (not on this team)</option>
              )}
              {agents.map((agent) => {
                const cli = runtimeLabel(agent.runtime)
                const refused = refusalsFor(agent.runtime)
                return (
                  <option key={agent.id} value={agent.id} disabled={refused}>
                    {agent.name}
                    {cli ? ` · ${cli}` : ''}
                    {refused ? ' (can’t take workflow steps)' : ''}
                  </option>
                )
              })}
            </select>
          </label>
          {codingNote && <p className="small muted bold-recipes-hint">{codingNote}</p>}
          <TemplateField
            label="Instruction"
            value={node.instruction}
            onChange={(value) => patch({ instruction: value }, `instruction:${node.id}`)}
            draft={draft}
            nodeId={node.id}
            rows={7}
            invalid={node.instruction.trim() === ''}
          />
          <p className="small muted bold-recipes-hint">
            Use <code>{`{{inputs.${draft.inputs[0]?.name ?? 'name'}}}`}</code> or an earlier step’s{' '}
            <code>{`{{nodes.${agentNodes.find((item) => item.id !== node.id)?.id ?? 'name'}.output}}`}</code>
            .
          </p>
          <div className="bold-recipes-inspector-grid">
            <label className="orch-field">
              <span>Retries</span>
              <select
                value={node.retries}
                disabled={!editable}
                onChange={(event) => patch({ retries: Number(event.target.value) })}
              >
                {[0, 1, 2].map((n) => (
                  <option key={n} value={n}>
                    {n}
                  </option>
                ))}
              </select>
            </label>
            <label className="orch-field">
              <span>If it fails</span>
              <select
                value={node.onFailure}
                disabled={!editable}
                onChange={(event) =>
                  commit(setFailureMode(draft, node.id, event.target.value as 'route' | 'fail_run'))
                }
              >
                <option value="fail_run">Stop the job</option>
                <option value="route">Go to a repair step</option>
              </select>
            </label>
          </div>
          {node.onFailure === 'route' && failRoute && (
            <label className="orch-field">
              <span>Failure goes to</span>
              <select
                value={failRoute.edges[0]?.to ?? ''}
                disabled={!editable}
                onChange={(event) => point('failed', event.target.value || null)}
              >
                <option value="">Not connected</option>
                {analysis.order
                  .filter((target) => target.id !== node.id)
                  .map((target) => (
                    <option key={target.id} value={target.id}>
                      {targetStepLabel(analysis, target.id)}
                    </option>
                  ))}
              </select>
            </label>
          )}
        </>
      )}

      {node.kind === 'gate' && (
        <section data-protected="block" className="bold-recipes-gate" aria-label="Gate decision">
          <TemplateField
            label="Question"
            value={node.question}
            onChange={(value) => patch({ question: value }, `question:${node.id}`)}
            draft={draft}
            nodeId={node.id}
            rows={3}
            invalid={node.question.trim() === ''}
          />
          <p className="small muted">
            The job stops here until you approve or reject. Rejecting stops the job unless you add a
            rejection path.
          </p>
          <label className="orch-field">
            <span>If rejected</span>
            <select
              value={node.onReject}
              disabled={!editable}
              onChange={(event) =>
                commit(setRejectMode(draft, node.id, event.target.value as 'route' | 'stop_run'))
              }
            >
              <option value="stop_run">Stop the job</option>
              <option value="route">Go to its own path</option>
            </select>
          </label>
          {node.onReject === 'route' && rejectRoute && (
            <label className="orch-field">
              <span>Rejection goes to</span>
              <select
                value={rejectRoute.edges[0]?.to ?? ''}
                disabled={!editable}
                onChange={(event) => point('rejected', event.target.value || null)}
              >
                <option value="">Not connected</option>
                {analysis.order
                  .filter((target) => target.id !== node.id)
                  .map((target) => (
                    <option key={target.id} value={target.id}>
                      {targetStepLabel(analysis, target.id)}
                    </option>
                  ))}
              </select>
            </label>
          )}
        </section>
      )}

      {(node.kind === 'agent' || node.kind === 'gate' || node.kind === 'join') && doneRoute && (
        <label className="orch-field">
          <span>{doneRoute.label} goes to</span>
          <select
            value={doneRoute.edges[0]?.to ?? ''}
            disabled={!editable}
            onChange={(event) => point('ok', event.target.value || null)}
          >
            <option value="">Not connected</option>
            {analysis.order
              .filter((target) => target.id !== node.id)
              .map((target) => (
                <option key={target.id} value={target.id}>
                  {targetStepLabel(analysis, target.id)}
                </option>
              ))}
          </select>
        </label>
      )}

      {node.kind === 'branch' && (
        <>
          <label className="orch-field">
            <span>Looks at</span>
            <select
              value={node.subject}
              disabled={!editable}
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
          <fieldset className="orch-field bold-recipes-rules">
            <legend>Decide by</legend>
            {node.rules.map((rule, index) => (
              <div key={rule.id} className="bold-recipes-rule">
                <select
                  aria-label={index === 0 ? 'Decide by' : `Rule ${index + 1} condition`}
                  value={conditionKey(rule.when)}
                  disabled={!editable}
                  onChange={(event) =>
                    commit(
                      updateRule(
                        draft,
                        node.id,
                        rule.id,
                        conditionFrom(event.target.value as ConditionKey, rule.when),
                      ),
                    )
                  }
                >
                  <option value="verdict:passed">The verdict is passed</option>
                  <option value="verdict:changes_requested">
                    The verdict is changes requested
                  </option>
                  <option value="outcome:succeeded">The step succeeded</option>
                  <option value="outcome:failed">The step failed</option>
                  <option value="output_contains">Whether its output contains some text</option>
                </select>
                {rule.when.kind === 'output_contains' && (
                  <input
                    aria-label={`Rule ${index + 1} text`}
                    value={rule.when.text}
                    maxLength={200}
                    disabled={!editable}
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
                  disabled={!editable || node.rules.length <= 1}
                  onClick={() => commit(removeRule(draft, node.id, rule.id))}
                >
                  Remove
                </button>
              </div>
            ))}
            <div className="bold-recipes-rule">
              <span className="small muted">otherwise</span>
              <span className="small muted">Always needed</span>
            </div>
            <button
              type="button"
              className="btn sm"
              disabled={!editable || node.rules.length >= 8}
              onClick={() => commit(addRule(draft, node.id))}
            >
              Add a rule
            </button>
          </fieldset>
          <p className="small muted">
            Every branch needs an otherwise path. A recipe only moves forward, so a path can lead to
            any later step, never back to an earlier one.
          </p>
        </>
      )}

      {node.kind === 'join' && (
        <p className="small muted">
          Waits for{' '}
          {row.incoming
            .map((edge) => analysis.order.find((item) => item.id === edge.from)?.label || edge.from)
            .join(', ') || 'nothing yet'}
          . A join waits for every path that leads into it.
        </p>
      )}

      {node.kind === 'end' && <p className="small muted">The run finishes when it gets here.</p>}
      <p className="small muted">
        In the graph, this step is <code>{node.id}</code>.
      </p>
      <span className="small muted">
        Step {row.index + 1} of {analysis.rows.length}
      </span>
    </fieldset>
  )
}
