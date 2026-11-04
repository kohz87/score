import type { AgentSummary, WorkflowNode } from '@score/contract'
import { useState, type ReactNode } from 'react'
import { AgentGlyph } from '../components/AgentGlyph.tsx'
import { TemplateField } from '../routes/workflows/TemplateField.tsx'
import { updateNode, type Draft } from '../routes/workflows/workflow-model.ts'

// The phone's step sheet (mock-up 19-recipes-phone): compact, with the kicker, the title, the instruction and two
// buttons. "More settings" opens the rest of the step's settings (the full inspector) inside the sheet.

const KICKER: Record<Exclude<WorkflowNode['kind'], 'agent'>, string> = {
  gate: 'You · approval',
  branch: 'Branch',
  join: 'Join',
  end: 'Done',
}

export function RecipeSheet({
  draft,
  node,
  step,
  agents,
  commit,
  onDelete,
  readOnly,
  more,
}: {
  draft: Draft
  node: WorkflowNode
  step: number | null
  agents: AgentSummary[]
  commit: (draft: Draft, coalesce?: string) => void
  onDelete: () => void
  readOnly: boolean
  /** The rest of the settings, shown under "More settings". */
  more: ReactNode
}) {
  const [open, setOpen] = useState(false)
  const agent = node.kind === 'agent' ? agents.find((item) => item.id === node.agentId) : undefined
  const patch = (change: Partial<WorkflowNode>, coalesce: string) =>
    commit(updateNode(draft, node.id, change), coalesce)
  return (
    <div className="rl-sheet" data-node-id={node.id}>
      <div className="rl-sheet-title">
        <span
          className="rl-sheet-kicker"
          style={agent ? ({ '--rl-agent': agent.style.color } as React.CSSProperties) : undefined}
        >
          {node.kind === 'agent' ? (
            <>
              {agent && <AgentGlyph agent={agent} size="xs" decorative />}
              <span>
                Step {step ?? ''} · {agent?.name ?? node.agentId}
              </span>
            </>
          ) : (
            KICKER[node.kind]
          )}
        </span>
        <h3>{node.label || node.id}</h3>
      </div>
      {!open && (node.kind === 'agent' || node.kind === 'gate') && (
        <fieldset className="rl-sheet-field" disabled={readOnly}>
          {node.kind === 'agent' ? (
            <TemplateField
              label="Instruction"
              value={node.instruction}
              onChange={(value) => patch({ instruction: value }, `instruction:${node.id}`)}
              draft={draft}
              nodeId={node.id}
              rows={3}
              invalid={node.instruction.trim() === ''}
            />
          ) : (
            <TemplateField
              label="Question"
              value={node.question}
              onChange={(value) => patch({ question: value }, `question:${node.id}`)}
              draft={draft}
              nodeId={node.id}
              rows={3}
              invalid={node.question.trim() === ''}
            />
          )}
        </fieldset>
      )}
      <div className="rl-sheet-actions">
        <button
          type="button"
          className="rl-sheet-btn"
          aria-expanded={open}
          onClick={() => setOpen((value) => !value)}
        >
          {open ? 'Fewer settings' : 'More settings'}
        </button>
        {!readOnly && (
          <button type="button" className="rl-sheet-btn rl-sheet-btn--line" onClick={onDelete}>
            Delete step
          </button>
        )}
      </div>
      {open && <div className="rl-sheet-more">{more}</div>}
    </div>
  )
}
