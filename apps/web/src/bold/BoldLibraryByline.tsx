import type { AgentSummary, KnowledgeAuthor } from '@score/contract'
import { AuthorLabel } from '../routes/knowledge/NotePanels.tsx'
import { timeAgo } from '../routes/knowledge/knowledge-paths.ts'
import { isNotePath } from '../routes/knowledge/knowledge-files.ts'
import { useNote } from '../routes/knowledge/knowledge-queries.ts'

export function Byline({
  author,
  mtime,
  agents,
  detail = false,
}: {
  author: KnowledgeAuthor | null
  mtime?: string
  agents: AgentSummary[]
  detail?: boolean
}) {
  return (
    <span className={`bold-library-by${detail ? ' is-detail' : ''}`}>
      {author === 'outside' ? (
        'Last edited outside Score'
      ) : author ? (
        <>
          Last edited by <AuthorLabel author={author} agents={agents} />
        </>
      ) : (
        'Author not recorded'
      )}
      {detail && mtime && <> · {timeAgo(mtime)}</>}
    </span>
  )
}

export function SelectedByline({ path, agents }: { path: string; agents: AgentSummary[] }) {
  const note = useNote(isNotePath(path) ? path : null)
  if (!note.data) return null
  return <Byline author={note.data.lastAuthor} mtime={note.data.mtime} agents={agents} detail />
}
