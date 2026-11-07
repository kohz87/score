import { WORKFLOW_LIMITS, type AgentSummary, type WorkflowNode } from '@score/contract'
import { Connections } from './Connections.tsx'
import { NodeAgentSettings } from './NodeAgentSettings.tsx'
import { NodeBranchSettings } from './NodeBranchSettings.tsx'
import { NodeGateSettings } from './NodeGateSettings.tsx'
import { IdField, IssueLines } from './NodeInspectorFields.tsx'
import type { Commit, Patch } from './node-inspector-types.ts'
import { KIND_HELP, KIND_LABEL, updateNode, type Draft } from './workflow-model.ts'
import type { EditorIssue } from './workflow-validation.ts'

// The inspector of the node selected in the editor: its settings, its connections (the keyboard and screen reader way
// to connect, next to dragging on the canvas) and the validation problems that concern it.

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
  const patch: Patch = (change, coalesce) => commit(updateNode(draft, node.id, change), coalesce)
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
        <NodeAgentSettings
          draft={draft}
          node={node}
          agents={agents}
          commit={commit}
          patch={patch}
          issueFor={issueFor}
        />
      )}

      {node.kind === 'gate' && (
        <NodeGateSettings draft={draft} node={node} patch={patch} issueFor={issueFor} />
      )}

      {node.kind === 'branch' && (
        <NodeBranchSettings draft={draft} node={node} commit={commit} patch={patch} />
      )}

      <Connections draft={draft} node={node} commit={commit} announce={announce} />

      <div className="orch-actions wf-danger-zone">
        <button type="button" className="orch-danger" onClick={onDelete}>
          Delete {node.label || 'this step'}
        </button>
      </div>
    </div>
  )
}
