import type { AgentSummary, Workbench } from '@score/contract'
import { CommentCard } from './BoldWorkbenchCommentCard.tsx'
import { party } from './bold-workbench-model.ts'

export function LooseComments({
  comments,
  agents,
}: {
  comments: Workbench['looseComments']
  agents: Map<string, AgentSummary>
}) {
  if (comments.length === 0) return null
  return (
    <section className="bold-bench-loose" aria-label="Notes on other files">
      <span className="bold-bench-kicker">Notes on files this job did not change</span>
      {comments.map((comment) => (
        <div key={comment.id} className="bold-bench-loose-item">
          <code>{comment.path}</code>
          <CommentCard comment={comment} agent={party(agents, comment.by)} />
        </div>
      ))}
    </section>
  )
}
