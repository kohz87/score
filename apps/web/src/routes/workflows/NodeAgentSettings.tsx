import type { AgentSummary } from '@score/contract'
import { runtimeLabel } from '../../components/runtime-label.ts'
import { StepModelFields } from '../../bold/recipe-step/StepModelFields.tsx'
import { AgentChip } from '../orchestrations/RunDecisions.tsx'
import { TemplateField } from './TemplateField.tsx'
import { EstimateField } from './NodeInspectorFields.tsx'
import { refusalFor } from './node-inspector-helpers.ts'
import type { AgentNode, Commit, Patch } from './node-inspector-types.ts'
import type { Draft } from './workflow-model.ts'

export function NodeAgentSettings({
  draft,
  node,
  agents,
  commit,
  patch,
  issueFor,
}: {
  draft: Draft
  node: AgentNode
  agents: AgentSummary[]
  commit: Commit
  patch: Patch
  issueFor: (field: string) => boolean
}) {
  const picked = agents.find((agent) => agent.id === node.agentId)
  const codingNote =
    picked?.runtime === 'claude-code' || picked?.runtime === 'codex'
      ? `${runtimeLabel(picked.runtime)} works on this computer, in its own workspace. Starting the run asks you to accept what it can read.`
      : null

  return (
    <>
      <label className="orch-field">
        <span>Agent</span>
        <select
          value={node.agentId}
          aria-invalid={node.agentId === '' ? true : undefined}
          onChange={(event) => patch({ agentId: event.target.value })}
        >
          {node.agentId === '' && <option value="">Choose an agent…</option>}
          {node.agentId !== '' && !agents.some((agent) => agent.id === node.agentId) && (
            <option value={node.agentId}>{node.agentId} (not on this team)</option>
          )}
          {agents.map((agent) => {
            const cli = runtimeLabel(agent.runtime)
            const refused = refusalFor(agent.runtime)
            return (
              <option key={agent.id} value={agent.id} disabled={refused !== null}>
                {agent.name}
                {cli ? ` · ${cli}` : ''}
                {refused ? ` (${refused})` : ''}
              </option>
            )
          })}
        </select>
        {node.agentId !== '' && <AgentChip agentId={node.agentId} agents={agents} />}
        {codingNote && <small className="orch-muted">{codingNote}</small>}
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
      <StepModelFields draft={draft} node={node} agents={agents} commit={commit} />
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
  )
}
