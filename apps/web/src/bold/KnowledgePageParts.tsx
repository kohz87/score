import type { AgentSummary, KnowledgeTree } from '@score/contract'
import type { UseQueryResult } from '@tanstack/react-query'
import { useMemo } from 'react'
import { useKnowledgeAccess } from '../routes/team/knowledge-access-queries.ts'
import { TYPE_LABEL } from '../routes/knowledge/knowledge-files.ts'
import { AuthorLabel } from '../routes/knowledge/NotePanels.tsx'
import { baseName, folderOf, timeAgo } from '../routes/knowledge/knowledge-paths.ts'
import { agentDisplayName, onTeam } from './bold-agents.ts'
import { PlusIcon } from './BoldIcons.tsx'

// 3.19.0: the pieces only the Knowledge page uses (folder rail, flat note list). Mock-up:
// docs/design/bold/mockups/16-knowledge.dc.html. The editor, dialogs and queries stay in BoldLibrary.

/** The rail's filter value for "uploaded files"; real folder paths never start with a slash. */
export const PAGE_DOCUMENTS = '/documents'

const inside = (path: string, folder: string) => path.startsWith(`${folder}/`)

function AgentRead({ agent }: { agent: AgentSummary }) {
  const access = useKnowledgeAccess(agent.id)
  if (access.data?.enabled !== true) return null
  return <li>{agentDisplayName(agent)}</li>
}

/** Who can read Knowledge: an agent's access is all or nothing (Agents › Knowledge access). */
function WhoCanRead({ agents }: { agents: AgentSummary[] }) {
  const team = agents.filter(onTeam)
  return (
    <section className="bold-knowledge-readers" aria-label="Who can read it">
      <h2>Who can read it</h2>
      <ul>
        {team.map((agent) => (
          <AgentRead key={agent.id} agent={agent} />
        ))}
      </ul>
      <p className="muted small">Set per agent on its page, under Knowledge access.</p>
    </section>
  )
}

export function FolderRail({
  tree,
  agents,
  filter,
  onFilter,
  onNewNote,
}: {
  tree: KnowledgeTree | undefined
  agents: AgentSummary[]
  filter: string
  onFilter: (next: string) => void
  onNewNote: () => void
}) {
  const rows = useMemo(() => {
    if (!tree) return []
    return [...tree.folders]
      .sort((a, b) => a.localeCompare(b))
      .map((folder) => ({
        folder,
        depth: folder.split('/').length - 1,
        count:
          tree.notes.filter((note) => inside(note.path, folder)).length +
          tree.documents.filter((doc) => inside(doc.path, folder)).length,
      }))
  }, [tree])
  const item = (value: string, label: string, count: number, depth = 0) => (
    <button
      key={value || 'all'}
      type="button"
      className={`bold-knowledge-folder${filter === value ? ' is-on' : ''}`}
      aria-current={filter === value ? 'true' : undefined}
      style={{ paddingLeft: `calc(12px + ${depth * 14}px)` }}
      onClick={() => onFilter(value)}
    >
      <span>{label}</span>
      <span className="bold-knowledge-count">{count}</span>
    </button>
  )
  return (
    <aside className="bold-knowledge-rail" aria-label="Folders">
      <div className="bold-knowledge-railhead">
        <h1>Knowledge</h1>
        <button
          type="button"
          className="bold-knowledge-plus"
          aria-label="New note"
          onClick={onNewNote}
        >
          <PlusIcon size={16} />
        </button>
      </div>
      <div className="bold-knowledge-folders">
        {item('', 'All notes', tree ? tree.notes.length + tree.documents.length : 0)}
        {rows.map((row) => item(row.folder, baseName(row.folder), row.count, row.depth))}
        {item(PAGE_DOCUMENTS, 'Documents', tree?.documents.length ?? 0)}
      </div>
      <WhoCanRead agents={agents} />
    </aside>
  )
}

/** The middle column: notes and files of the chosen folder, newest first, as the mock-up's rows. */
export function PageList({
  tree,
  agents,
  filter,
  active,
  onOpen,
}: {
  tree: UseQueryResult<KnowledgeTree>
  agents: AgentSummary[]
  filter: string
  active: string | null
  onOpen: (path: string) => void
}) {
  const rows = useMemo(() => {
    const data = tree.data
    if (!data) return []
    const wanted =
      filter === ''
        ? [...data.notes, ...data.documents]
        : filter === PAGE_DOCUMENTS
          ? data.documents
          : [...data.notes, ...data.documents].filter((entry) => inside(entry.path, filter))
    return [...wanted].sort((a, b) => Date.parse(b.mtime) - Date.parse(a.mtime))
  }, [tree.data, filter])
  return (
    <div className="bold-knowledge-list">
      {tree.isPending && <p role="status">Loading notes…</p>}
      {tree.isError && <p role="alert">Couldn’t load the notes.</p>}
      {tree.data && rows.length === 0 && (
        <p className="bold-library-empty-list">
          {tree.data.notes.length === 0 && tree.data.documents.length === 0
            ? 'No notes yet. Start one with the + or upload a file.'
            : 'Nothing in here yet.'}
        </p>
      )}
      {rows.map((entry) => {
        const note = 'title' in entry
        const folder = folderOf(entry.path)
        return (
          <button
            key={entry.path}
            data-path={entry.path}
            type="button"
            className={`bold-knowledge-row${active === entry.path ? ' is-on' : ''}`}
            aria-current={active === entry.path ? 'page' : undefined}
            onClick={() => onOpen(entry.path)}
          >
            <strong>{note ? entry.title || baseName(entry.path) : baseName(entry.path)}</strong>
            <span className="bold-knowledge-meta">
              {folder ? `${baseName(folder)} · ` : ''}
              {!note && `${TYPE_LABEL[entry.type]} · `}
              {entry.lastAuthor === 'outside' ? (
                'edited outside Score'
              ) : entry.lastAuthor ? (
                <>
                  edited by <AuthorLabel author={entry.lastAuthor} agents={agents} />
                </>
              ) : (
                'author not recorded'
              )}{' '}
              · {timeAgo(entry.mtime)}
            </span>
          </button>
        )
      })}
    </div>
  )
}
