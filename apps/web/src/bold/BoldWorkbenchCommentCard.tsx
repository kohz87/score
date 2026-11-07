import type { AgentSummary, WorkbenchComment } from '@score/contract'
import { AgentName } from './BoldWorkbenchAgentName.tsx'
import { COMMENT_LABEL } from './bold-workbench-model.ts'

export function CommentCard({
  comment,
  agent,
}: {
  comment: WorkbenchComment
  agent: AgentSummary | undefined
}) {
  const status = comment.outdated
    ? `Outdated · was line ${comment.originalLine}`
    : COMMENT_LABEL[comment.kind]
  return (
    <div
      className={`bold-bench-comment${comment.outdated ? ' is-outdated' : ''}`}
      data-comment={comment.kind}
      data-outdated={comment.outdated ? 'true' : undefined}
    >
      <AgentName agent={agent} id={comment.by} />
      <span className="bold-bench-comment-text">{comment.text}</span>
      <span className="bold-bench-comment-state">{status}</span>
    </div>
  )
}
