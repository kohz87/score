import type { GateNode, Patch } from './node-inspector-types.ts'
import type { Draft } from './workflow-model.ts'
import { TemplateField } from './TemplateField.tsx'

export function NodeGateSettings({
  draft,
  node,
  patch,
  issueFor,
}: {
  draft: Draft
  node: GateNode
  patch: Patch
  issueFor: (field: string) => boolean
}) {
  return (
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
  )
}
