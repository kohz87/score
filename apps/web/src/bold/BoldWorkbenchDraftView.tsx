import type { AgentSummary, Workbench } from '@score/contract'
import { Link } from 'react-router'
import { boldAgentWorkspaceLink } from './bold-links.ts'
import { AgentName } from './BoldWorkbenchAgentName.tsx'

export function DraftView({
  draft,
  agent,
}: {
  draft: Workbench['drafts'][number]
  agent: AgentSummary | undefined
}) {
  const target = draft.target.kind === 'document' ? 'Attached document' : 'In the workspace'
  return (
    <article className="bold-bench-draft" data-draft={draft.id}>
      <header className="bold-bench-file-head">
        <div className="bold-bench-file-title">
          <span className="bold-bench-kicker">Draft</span>
          <h2>{draft.title}</h2>
        </div>
        <AgentName agent={agent} id={draft.agentId} />
      </header>
      <span
        className="bold-bench-draft-preview"
        aria-hidden="true"
        style={{ background: agent?.style.color ?? 'var(--field)' }}
      >
        <span />
        <span />
        <span />
      </span>
      <p className="bold-bench-caption">{target}</p>
      {draft.target.kind === 'workspace' && (
        <Link className="btn sm" to={boldAgentWorkspaceLink(draft.agentId, draft.target.path)}>
          Open in the workspace
        </Link>
      )}
    </article>
  )
}
