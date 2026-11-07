import type { WorkflowNode } from '@score/contract'
import { useId, useState } from 'react'
import { renameNode, type Draft } from './workflow-model.ts'
import type { Commit } from './node-inspector-types.ts'
import type { EditorIssue } from './workflow-validation.ts'

export function IssueLines({ issues }: { issues: EditorIssue[] }) {
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

export function IdField({
  draft,
  node,
  commit,
}: {
  draft: Draft
  node: WorkflowNode
  commit: Commit
}) {
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
      return setError('Another step has that reference name.')
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

/** A dollar amount typed as text: "0." is on its way to "0.25", so the text is kept apart from the number. */
export function EstimateField({
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
