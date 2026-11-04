import type { AgentSummary, KnowledgeTree } from '@score/contract'
import type { UseQueryResult } from '@tanstack/react-query'
import {
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import { TYPE_LABEL } from '../routes/knowledge/knowledge-files.ts'
import { AuthorLabel } from '../routes/knowledge/NotePanels.tsx'
import { baseName, folderOf, timeAgo } from '../routes/knowledge/knowledge-paths.ts'
import { PlusIcon } from './BoldIcons.tsx'

// 3.19.0: the pieces only the Knowledge page uses (folder rail, flat note list). Mock-up:
// docs/design/bold/mockups/16-knowledge.dc.html. The editor, dialogs and queries stay in BoldLibrary.

/** The rail's filter value for "uploaded files"; real folder paths never start with a slash. */
export const PAGE_DOCUMENTS = '/documents'

const inside = (path: string, folder: string) => path.startsWith(`${folder}/`)

/** The ⋯ on a folder row: Rename, Move and Delete, as a real menu (arrows, Home/End, Escape returns focus). */
function FolderMenu({
  folder,
  onRename,
  onMove,
  onDelete,
}: {
  folder: string
  onRename: (folder: string) => void
  onMove: (folder: string) => void
  onDelete: (folder: string) => void
}) {
  const [open, setOpen] = useState(false)
  const root = useRef<HTMLSpanElement>(null)
  const trigger = useRef<HTMLButtonElement>(null)
  const menuId = useId()
  const name = baseName(folder)
  useEffect(() => {
    if (!open) return
    const first = requestAnimationFrame(() => {
      root.current?.querySelector<HTMLElement>('[role="menuitem"]')?.focus()
    })
    const outside = (event: Event) => {
      if (!root.current?.contains(event.target as Node)) setOpen(false)
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      event.preventDefault()
      event.stopPropagation()
      setOpen(false)
      trigger.current?.focus()
    }
    document.addEventListener('pointerdown', outside)
    document.addEventListener('focusin', outside)
    document.addEventListener('keydown', escape, true)
    return () => {
      cancelAnimationFrame(first)
      document.removeEventListener('pointerdown', outside)
      document.removeEventListener('focusin', outside)
      document.removeEventListener('keydown', escape, true)
    }
  }, [open])
  function move(event: ReactKeyboardEvent<HTMLElement>) {
    if (!['ArrowDown', 'ArrowUp', 'Home', 'End'].includes(event.key)) return
    const items = [...event.currentTarget.querySelectorAll<HTMLElement>('[role="menuitem"]')]
    event.preventDefault()
    const at = items.indexOf(document.activeElement as HTMLElement)
    const next =
      event.key === 'Home'
        ? 0
        : event.key === 'End'
          ? items.length - 1
          : event.key === 'ArrowDown'
            ? (at + 1) % items.length
            : (at - 1 + items.length) % items.length
    items[next]?.focus()
  }
  const pick = (action: (folder: string) => void) => () => {
    setOpen(false)
    action(folder)
  }
  return (
    <span className="bold-knowledge-fmenu" ref={root}>
      <button
        ref={trigger}
        type="button"
        className="bold-knowledge-dots"
        aria-label={`Folder actions for ${name}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="bold-dots" aria-hidden="true">
          <span />
          <span />
          <span />
        </span>
      </button>
      {open && (
        <div
          className="menu bold-knowledge-menu"
          id={menuId}
          role="menu"
          aria-label={`${name} actions`}
          onKeyDown={move}
        >
          <button type="button" className="mi" role="menuitem" onClick={pick(onRename)}>
            Rename…
          </button>
          <button type="button" className="mi" role="menuitem" onClick={pick(onMove)}>
            Move to…
          </button>
          <button type="button" className="mi bad" role="menuitem" onClick={pick(onDelete)}>
            Delete…
          </button>
        </div>
      )}
    </span>
  )
}

export function FolderRail({
  tree,
  filter,
  onFilter,
  onNewNote,
  onNewFolder,
  onRenameFolder,
  onMoveFolder,
  onDeleteFolder,
}: {
  tree: KnowledgeTree | undefined
  filter: string
  onFilter: (next: string) => void
  onNewNote: () => void
  onNewFolder: () => void
  onRenameFolder: (folder: string) => void
  onMoveFolder: (folder: string) => void
  onDeleteFolder: (folder: string) => void
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
  // Only real folders have the ⋯ ("All notes" and "Documents" are filters, not folders).
  const item = (value: string, label: string, count: number, depth = 0, actions = false) => (
    <div key={value || 'all'} className={`bold-knowledge-frow${filter === value ? ' is-on' : ''}`}>
      <button
        type="button"
        className={`bold-knowledge-folder${filter === value ? ' is-on' : ''}`}
        aria-current={filter === value ? 'true' : undefined}
        style={{ paddingLeft: `calc(12px + ${depth * 14}px)` }}
        onClick={() => onFilter(value)}
      >
        <span>{label}</span>
        <span className="bold-knowledge-count">{count}</span>
      </button>
      {actions && (
        <FolderMenu
          folder={value}
          onRename={onRenameFolder}
          onMove={onMoveFolder}
          onDelete={onDeleteFolder}
        />
      )}
    </div>
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
        {rows.map((row) => item(row.folder, baseName(row.folder), row.count, row.depth, true))}
        {item(PAGE_DOCUMENTS, 'Documents', tree?.documents.length ?? 0)}
      </div>
      <button type="button" className="bold-knowledge-newfolder" onClick={onNewFolder}>
        <PlusIcon size={14} /> New folder
      </button>
      <p className="bold-knowledge-newfolder-hint">Goes inside the folder you picked.</p>
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
