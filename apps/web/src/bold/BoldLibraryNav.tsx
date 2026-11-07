import type { AgentSummary } from '@score/contract'
import { useRef, type Dispatch, type SetStateAction } from 'react'
import { Link } from 'react-router'
import { ACCEPT_FILES } from '../routes/knowledge/knowledge-files.ts'
import { baseName } from '../routes/knowledge/knowledge-paths.ts'
import type { useKnowledgeTree, useSearch } from '../routes/knowledge/knowledge-queries.ts'
import { BookIcon, PlusIcon, SearchIcon, UploadIcon } from './BoldIcons.tsx'
import { Byline } from './BoldLibraryByline.tsx'
import { SearchResults } from './BoldLibrarySearchResults.tsx'
import { filesInDrag, folderChain, type Dialog, type noteGroups } from './bold-library-model.ts'
import { FolderRail, PageList } from './KnowledgePageParts.tsx'

export function BoldLibraryNav({
  active,
  agents,
  chosen,
  collapsed,
  debounced,
  dropTarget,
  flowBusy,
  folded,
  groups,
  onDialog,
  onDragging,
  onDropTarget,
  onExportAll,
  onFiles,
  onFilter,
  onOpen,
  onPickedFolder,
  onQueryChange,
  onToggleFolder,
  onToggleList,
  onUpload,
  page,
  pageFilter,
  picked,
  query,
  reading,
  search,
  searching,
  section,
  tree,
  uploadFolder,
}: {
  active: string | null
  agents: AgentSummary[]
  chosen: boolean
  collapsed: Set<string>
  debounced: string
  dropTarget: string | null
  flowBusy: boolean
  folded: boolean
  groups: ReturnType<typeof noteGroups>
  onDialog: (dialog: Dialog) => void
  onDragging: (dragging: boolean) => void
  onDropTarget: Dispatch<SetStateAction<string | null>>
  onExportAll: () => void
  onFiles: () => void
  onFilter: (filter: string) => void
  onOpen: (path: string) => void
  onPickedFolder: (folder: string) => void
  onQueryChange: (query: string) => void
  onToggleFolder: (folder: string) => void
  onToggleList: () => void
  onUpload: (files: File[], folder: string) => void
  page: boolean
  pageFilter: string
  picked: string
  query: string
  reading: boolean
  search: ReturnType<typeof useSearch>
  searching: boolean
  section: 'notes' | 'files'
  tree: ReturnType<typeof useKnowledgeTree>
  uploadFolder: string
}) {
  const uploadInput = useRef<HTMLInputElement>(null)

  return (
    <>
      {page && !reading && (
        <FolderRail
          tree={tree.data}
          filter={pageFilter}
          onFilter={onFilter}
          onNewNote={() => onDialog({ kind: 'new', initial: picked ? `${picked}/` : '' })}
          onNewFolder={() => onDialog({ kind: 'folder', parent: picked, fromNav: true })}
          onRenameFolder={(folder) => onDialog({ kind: 'folder-move', path: folder })}
          onMoveFolder={(folder) => onDialog({ kind: 'folder-move', path: folder })}
          onDeleteFolder={(folder) => onDialog({ kind: 'folder-delete', path: folder })}
        />
      )}
      <nav
        className="bold-library-nav"
        aria-label="Library notes"
        data-folded={folded ? '' : undefined}
        hidden={reading}
      >
        {chosen && (
          // 3.8.1 (owner, phone): with a note open the list folds to this bar, so the note is what the screen shows.
          <button
            type="button"
            className="bold-library-fold"
            aria-expanded={!folded}
            onClick={onToggleList}
          >
            <span>{folded ? 'Notes and files' : 'Hide the list'}</span>
            <span aria-hidden="true">{folded ? '▾' : '▴'}</span>
          </button>
        )}
        {folded && (
          // The one tool used while reading a note stays in reach; the rest are behind the bar.
          <button
            type="button"
            className="bold-library-new"
            onClick={() => onDialog({ kind: 'new', initial: picked ? `${picked}/` : '' })}
          >
            <PlusIcon size={14} /> New note
          </button>
        )}
        {!folded && (
          <>
            <label className="bold-library-search">
              <SearchIcon size={14} />
              <span className="kn-sr">Search the Library</span>
              <input
                type="search"
                placeholder="Search"
                value={query}
                onChange={(event) => onQueryChange(event.target.value)}
              />
            </label>

            {searching ? (
              <SearchResults search={search} debounced={debounced} onOpen={onOpen} />
            ) : page ? (
              <PageList
                tree={tree}
                agents={agents}
                filter={pageFilter}
                active={section === 'notes' ? active : null}
                onOpen={onOpen}
              />
            ) : (
              <div className="bold-library-groups">
                {tree.isPending && <p role="status">Loading notes…</p>}
                {tree.isError && <p role="alert">Couldn’t load the notes.</p>}
                {tree.data &&
                  groups
                    .filter(
                      ([folder]) =>
                        !folderChain(folder)
                          .slice(0, -1)
                          .some((up) => collapsed.has(up)),
                    )
                    .map(([folder, items]) => (
                      <section
                        key={folder || 'root'}
                        aria-label={folder || 'Notes'}
                        className={`bold-library-group${dropTarget === folder ? ' is-drop' : ''}`}
                        onDragOver={(event) => {
                          if (!filesInDrag(event)) return
                          event.preventDefault()
                          event.stopPropagation()
                          onDragging(true)
                          onDropTarget(folder)
                        }}
                        onDragLeave={(event) => {
                          if (event.currentTarget.contains(event.relatedTarget as Node | null))
                            return
                          onDropTarget((current) => (current === folder ? null : current))
                        }}
                        onDrop={(event) => {
                          if (!filesInDrag(event)) return
                          event.preventDefault()
                          event.stopPropagation()
                          onUpload([...event.dataTransfer.files], folder)
                        }}
                      >
                        {folder === '' ? (
                          <h2 className={`bold-library-folder${picked === '' ? ' is-picked' : ''}`}>
                            <button
                              type="button"
                              className="bold-library-folder-toggle"
                              aria-pressed={picked === ''}
                              onClick={() => onPickedFolder('')}
                            >
                              Notes
                            </button>
                          </h2>
                        ) : (
                          <h2
                            className={`bold-library-folder${picked === folder ? ' is-picked' : ''}`}
                            style={{ paddingLeft: 10 + (folder.split('/').length - 1) * 14 }}
                          >
                            <button
                              type="button"
                              className="bold-library-folder-toggle bold-library-chevron"
                              aria-expanded={!collapsed.has(folder)}
                              aria-label={`${collapsed.has(folder) ? 'Expand' : 'Collapse'} ${folder}`}
                              onClick={() => onToggleFolder(folder)}
                            >
                              {collapsed.has(folder) ? '▸' : '▾'}
                            </button>
                            <button
                              type="button"
                              className="bold-library-folder-toggle"
                              aria-pressed={picked === folder}
                              title={folder}
                              onClick={() => onPickedFolder(folder)}
                            >
                              {baseName(folder)}
                              {items.length === 0 && (
                                <span className="bold-library-empty"> (empty)</span>
                              )}
                            </button>
                          </h2>
                        )}
                        {!collapsed.has(folder) &&
                          items.map((note) => (
                            <button
                              key={note.path}
                              type="button"
                              className={`bold-library-item${active === note.path && section === 'notes' ? ' is-selected' : ''}`}
                              aria-current={
                                active === note.path && section === 'notes' ? 'page' : undefined
                              }
                              onClick={() => onOpen(note.path)}
                            >
                              <span className="bold-library-item-title">
                                {note.title || baseName(note.path)}
                              </span>
                              <Byline author={note.lastAuthor} agents={agents} />
                            </button>
                          ))}
                      </section>
                    ))}
                {tree.data && tree.data.notes.length === 0 && (
                  <p className="bold-library-empty-list">
                    No notes yet. Start one below or upload a file.
                  </p>
                )}
              </div>
            )}

            <div className="bold-library-tools">
              {!page && (
                <Link
                  className="bold-library-open"
                  to={active ? `/b/knowledge?note=${encodeURIComponent(active)}` : '/b/knowledge'}
                >
                  Open Knowledge
                </Link>
              )}
              {!page && (
                <button
                  type="button"
                  className="bold-library-new"
                  onClick={() => onDialog({ kind: 'new', initial: picked ? `${picked}/` : '' })}
                >
                  <PlusIcon size={14} /> New note
                </button>
              )}
              {!page && (
                <>
                  <button
                    type="button"
                    onClick={() => onDialog({ kind: 'folder', parent: picked, fromNav: true })}
                  >
                    <PlusIcon size={14} /> New folder
                  </button>
                  {/* 3.14.5 (owner): the picked folder can be renamed or deleted from here too. */}
                  {picked !== '' && (
                    <>
                      <button
                        type="button"
                        aria-label={`Rename folder ${baseName(picked)}`}
                        onClick={() => onDialog({ kind: 'folder-move', path: picked })}
                      >
                        Rename folder
                      </button>
                      <button
                        type="button"
                        aria-label={`Delete folder ${baseName(picked)}`}
                        onClick={() => onDialog({ kind: 'folder-delete', path: picked })}
                      >
                        Delete folder
                      </button>
                    </>
                  )}
                </>
              )}
              <input
                ref={uploadInput}
                type="file"
                multiple
                hidden
                accept={ACCEPT_FILES}
                aria-label="Choose files to upload to the Library"
                onChange={(event) => {
                  const files = [...(event.target.files ?? [])]
                  event.target.value = ''
                  onUpload(files, uploadFolder)
                }}
              />
              <button
                type="button"
                disabled={flowBusy}
                onClick={() => uploadInput.current?.click()}
              >
                <UploadIcon size={14} /> {flowBusy ? 'Uploading…' : 'Upload'}
              </button>
              <button type="button" aria-pressed={section === 'files'} onClick={onFiles}>
                <BookIcon size={14} /> Files
              </button>
              <button type="button" onClick={onExportAll}>
                Export
              </button>
            </div>
          </>
        )}
      </nav>
    </>
  )
}
