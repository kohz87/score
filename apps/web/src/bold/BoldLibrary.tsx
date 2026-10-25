import type {
  AgentSummary,
  KnowledgeAuthor,
  KnowledgeChanged,
  KnowledgeExportRequest,
  KnowledgeNoteSummary,
} from '@score/contract'
import { useEffect, useMemo, useRef, useState } from 'react'
import { useMediaQuery } from '../data/use-media.ts'
import { DocumentWorkspace } from '../routes/knowledge/DocumentWorkspace.tsx'
import { ExportDialog } from '../routes/knowledge/ExportDialog.tsx'
import { FilesView } from '../routes/knowledge/FilesView.tsx'
import {
  DeleteDialog,
  MoveDialog,
  NewFolderDialog,
  NewNoteDialog,
} from '../routes/knowledge/KnowledgeDialogs.tsx'
import { AuthorLabel } from '../routes/knowledge/NotePanels.tsx'
import { NoteWorkspace } from '../routes/knowledge/NoteWorkspace.tsx'
import { ACCEPT_FILES, TYPE_LABEL, isNotePath } from '../routes/knowledge/knowledge-files.ts'
import { useExport } from '../routes/knowledge/knowledge-export.ts'
import {
  baseName,
  folderOf,
  pathForLinkTarget,
  timeAgo,
} from '../routes/knowledge/knowledge-paths.ts'
import {
  UnsavedDraftError,
  knowledgeFailure,
  useKnowledgeActions,
  useKnowledgeInfo,
  useKnowledgeLive,
  useKnowledgeTree,
  useNote,
  useSearch,
} from '../routes/knowledge/knowledge-queries.ts'
import { splitSnippet } from '../routes/knowledge/wikilinks.ts'
import { summaryText, useUploadFlow } from '../routes/knowledge/UploadFlow.tsx'
import { BookIcon, PlusIcon, SearchIcon, UploadIcon } from './BoldIcons.tsx'
import './bold-library.css'

type Dialog =
  | { kind: 'new'; initial: string }
  | { kind: 'move'; path: string }
  | { kind: 'delete'; path: string }
  | { kind: 'folder'; parent: string }
  | null

type ExportRequest = { request: KnowledgeExportRequest; heading: string }
const PHONE = '(max-width: 860px)'

function Byline({
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

function SelectedByline({ path, agents }: { path: string; agents: AgentSummary[] }) {
  const note = useNote(isNotePath(path) ? path : null)
  if (!note.data) return null
  return <Byline author={note.data.lastAuthor} mtime={note.data.mtime} agents={agents} detail />
}

function noteGroups(tree: { folders: string[]; notes: KnowledgeNoteSummary[] }) {
  const groups = new Map<string, KnowledgeNoteSummary[]>()
  for (const folder of tree.folders) groups.set(folder, [])
  for (const note of tree.notes) {
    const folder = folderOf(note.path)
    groups.set(folder, [...(groups.get(folder) ?? []), note])
  }
  return [...groups.entries()]
    .filter(([folder, notes]) => folder !== '' || notes.length > 0)
    .sort(([a], [b]) => (a === '' ? -1 : b === '' ? 1 : a.localeCompare(b)))
}

/** The bold Library: the prototype's two-column side panel, backed by the classic Knowledge hooks and editors. */
export function BoldLibrary({
  agents,
  hidden = false,
  openPath = null,
}: {
  agents: AgentSummary[]
  hidden?: boolean
  /** A note named by `?note=` (Search); a new path wins even after someone picked another note by hand. */
  openPath?: string | null
}) {
  const phone = useMediaQuery(PHONE)
  const info = useKnowledgeInfo()
  const tree = useKnowledgeTree()
  const actions = useKnowledgeActions()
  const uploadInput = useRef<HTMLInputElement>(null)
  const mainRef = useRef<HTMLElement>(null)
  const flushRef = useRef<(() => Promise<boolean>) | null>(null)
  const registerFlush = (flush: (() => Promise<boolean>) | null) => {
    flushRef.current = flush
  }
  const [section, setSection] = useState<'notes' | 'files'>('notes')
  // `undefined` means "no explicit choice yet"; null keeps the blank state after the open note is deleted.
  const [selected, setSelected] = useState<string | null | undefined>(undefined)
  const [openedPath, setOpenedPath] = useState<string | null>(null)
  const [filesFolder, setFilesFolder] = useState('')
  const [query, setQuery] = useState('')
  const [debounced, setDebounced] = useState('')
  const [dragging, setDragging] = useState(false)
  const [dropTarget, setDropTarget] = useState<string | null>(null)
  const focusNote = useRef(false)
  const lastOpenedPath = useRef<string | null>(null)
  const [dialog, setDialog] = useState<Dialog>(null)
  const [dialogError, setDialogError] = useState<unknown>(null)
  const [exportRequest, setExportRequest] = useState<ExportRequest | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [external, setExternal] = useState<{
    forPath: string | null
    event: KnowledgeChanged
  } | null>(null)
  const search = useSearch(debounced)
  const exporter = useExport(setNotice)
  const flow = useUploadFlow((summary) => {
    const text = summaryText(summary)
    if (text) setNotice(text)
  })
  const notes = useMemo(() => tree.data?.notes ?? [], [tree.data])
  const groups = useMemo(() => (tree.data ? noteGroups(tree.data) : []), [tree.data])
  const searching = query.trim() !== ''
  // Like the prototype, a note is already open when the panel has one. An explicit choice wins even while the tree is
  // refetching after a create or move; without one, fall back to the first note (or the empty state).
  const active = useMemo(() => {
    if (selected !== undefined) return selected
    return section === 'notes' ? (tree.data?.notes[0]?.path ?? null) : null
  }, [section, selected, tree.data])

  if (openPath && openPath !== openedPath) {
    setOpenedPath(openPath)
    setSelected(openPath)
    setSection('notes')
    setQuery('')
  }
  const uploadFolder = section === 'files' ? filesFolder : folderOf(active ?? '')

  useEffect(() => {
    if (openedPath === null || lastOpenedPath.current === openedPath) return
    lastOpenedPath.current = openedPath
    focusNote.current = phone
  }, [openedPath, phone])

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), 250)
    return () => clearTimeout(timer)
  }, [query])

  // The same event refreshes every Knowledge query; here it also marks the open note as changed elsewhere.
  useKnowledgeLive((event) => {
    if (event.by !== 'you' && (event.path === active || event.to === active))
      setExternal({ forPath: active, event })
  })

  function open(next: string) {
    setSelected(next)
    setSection('notes')
    setQuery('')
    focusNote.current = phone
  }

  useEffect(() => {
    if (!phone || !focusNote.current) return
    let frame = 0
    let tries = 0
    const moveToHeading = () => {
      const main = mainRef.current
      const heading = main?.querySelector<HTMLElement>('.kn-note-head h2, .kn-doc h2')
      if (!heading && tries++ < 40) {
        frame = requestAnimationFrame(moveToHeading)
        return
      }
      if (!heading) return
      focusNote.current = false
      main?.scrollIntoView({ block: 'start' })
      heading.tabIndex = -1
      heading.focus({ preventScroll: true })
    }
    frame = requestAnimationFrame(moveToHeading)
    return () => cancelAnimationFrame(frame)
  }, [active, phone, section])

  function openDialog(next: Dialog) {
    setDialogError(null)
    setDialog(next)
  }

  function upload(files: File[], folder: string) {
    setDragging(false)
    setDropTarget(null)
    if (files.length === 0) return
    void flow.start(
      files.map((file) => ({ name: file.name, blob: file })),
      folder,
    )
  }

  function create(newPath: string) {
    actions.save.mutate(
      { path: newPath, body: `# ${baseName(newPath)}\n\n`, etag: null },
      {
        onSuccess: (response) => {
          setDialog(null)
          open(response.path)
        },
        onError: setDialogError,
      },
    )
  }

  function move(from: string, to: string, updateLinks: boolean) {
    actions.move.mutate(
      { from, to, updateLinks },
      {
        onSuccess: (response) => {
          setDialog(null)
          const left =
            response.skipped.length > 0
              ? ` Couldn’t update the links in ${response.skipped.map((item) => item.path).join(', ')}. They still link to the old name.`
              : ''
          setNotice(
            updateLinks
              ? `Moved to ${response.path}. Updated links in ${response.updatedNotes} ${response.updatedNotes === 1 ? 'note' : 'notes'}.${left}`
              : `Moved to ${response.path}. Links in other notes were left as they are.`,
          )
          if (from === active) open(response.path)
        },
        onError: setDialogError,
      },
    )
  }

  const filesInDrag = (event: { dataTransfer: DataTransfer }) =>
    event.dataTransfer.types.includes('Files')

  return (
    <div
      className={`sidebody bold-library${dragging ? ' is-dragging' : ''}`}
      data-testid="bold-library"
      hidden={hidden}
      onDragOver={(event) => {
        if (!filesInDrag(event)) return
        event.preventDefault()
        setDragging(true)
      }}
      onDragLeave={(event) => {
        if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
        setDragging(false)
        setDropTarget(null)
      }}
      onDrop={(event) => {
        if (!filesInDrag(event)) return
        event.preventDefault()
        setDragging(false)
        setDropTarget(null)
        // A file row in the Files view already handled this drop with its own folder.
        if (event.defaultPrevented) return
        upload([...event.dataTransfer.files], uploadFolder)
      }}
    >
      {dragging && (
        <p className="kn-drop-hint" role="status">
          {(dropTarget ?? uploadFolder) ? (
            <>
              Drop to add the files to <code>{dropTarget ?? uploadFolder}</code>
            </>
          ) : (
            'Drop to add the files to the top level of Knowledge (not into a folder)'
          )}
        </p>
      )}
      <nav className="bold-library-nav" aria-label="Library notes">
        <label className="bold-library-search">
          <SearchIcon size={14} />
          <span className="kn-sr">Search the Library</span>
          <input
            type="search"
            placeholder="Search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>

        {searching ? (
          <section className="bold-library-results" aria-label="Search results">
            {search.isPending && debounced !== '' && <p role="status">Searching…</p>}
            {search.isError && <p role="alert">Couldn’t search the Library. Try again.</p>}
            {search.data && search.data.length === 0 && (
              <p className="muted small">Nothing matches “{debounced}”.</p>
            )}
            <ul>
              {(search.data ?? []).map((hit) => (
                <li key={hit.path}>
                  <button type="button" onClick={() => open(hit.path)}>
                    <strong>
                      {hit.title || baseName(hit.path)}
                      {hit.kind === 'document' && hit.type && (
                        <span className="kn-type-badge">{TYPE_LABEL[hit.type]}</span>
                      )}
                    </strong>
                    <span className="kn-path">{hit.path}</span>
                    <span className="bold-library-snippet">
                      {splitSnippet(hit.snippet).map((part, index) =>
                        part.match ? <mark key={index}>{part.text}</mark> : part.text,
                      )}
                    </span>
                  </button>
                </li>
              ))}
            </ul>
          </section>
        ) : (
          <div className="bold-library-groups">
            {tree.isPending && <p role="status">Loading notes…</p>}
            {tree.isError && <p role="alert">Couldn’t load the notes.</p>}
            {tree.data &&
              groups.map(([folder, items]) => (
                <section
                  key={folder || 'root'}
                  aria-label={folder || 'Notes'}
                  className={`bold-library-group${dropTarget === folder ? ' is-drop' : ''}`}
                  onDragOver={(event) => {
                    if (!filesInDrag(event)) return
                    event.preventDefault()
                    event.stopPropagation()
                    setDragging(true)
                    setDropTarget(folder)
                  }}
                  onDragLeave={(event) => {
                    if (event.currentTarget.contains(event.relatedTarget as Node | null)) return
                    setDropTarget((current) => (current === folder ? null : current))
                  }}
                  onDrop={(event) => {
                    if (!filesInDrag(event)) return
                    event.preventDefault()
                    event.stopPropagation()
                    upload([...event.dataTransfer.files], folder)
                  }}
                >
                  <h2 className="bold-library-folder">{folder || 'Notes'}</h2>
                  {items.map((note) => (
                    <button
                      key={note.path}
                      type="button"
                      className={`bold-library-item${active === note.path && section === 'notes' ? ' is-selected' : ''}`}
                      aria-current={
                        active === note.path && section === 'notes' ? 'page' : undefined
                      }
                      onClick={() => open(note.path)}
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
          <button
            type="button"
            className="bold-library-new"
            onClick={() => openDialog({ kind: 'new', initial: '' })}
          >
            <PlusIcon size={14} /> New note
          </button>
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
              upload(files, uploadFolder)
            }}
          />
          <button type="button" disabled={flow.busy} onClick={() => uploadInput.current?.click()}>
            <UploadIcon size={14} /> {flow.busy ? 'Uploading…' : 'Upload'}
          </button>
          <button
            type="button"
            aria-pressed={section === 'files'}
            onClick={() => {
              setSection('files')
              setQuery('')
            }}
          >
            <BookIcon size={14} /> Files
          </button>
          <button
            type="button"
            onClick={() =>
              setExportRequest({ request: { all: true }, heading: 'Export all of Knowledge' })
            }
          >
            Export
          </button>
        </div>
      </nav>

      <section className="kn-main bold-library-main" aria-label="Library note" ref={mainRef}>
        {notice && (
          <p className="kn-banner" role="status">
            {notice}{' '}
            <button type="button" onClick={() => setNotice(null)}>
              Dismiss
            </button>
          </p>
        )}
        {info.data?.moveIssue && (
          <p className="kn-banner is-warn" role="status">
            {info.data.moveIssue.state === 'pending'
              ? `Move pending: ${info.data.moveIssue.from} to ${info.data.moveIssue.to}. Score is finishing it.`
              : `Move needs attention: ${info.data.moveIssue.message}`}{' '}
            {info.data.moveIssue.state === 'conflicted' && (
              <button type="button" onClick={() => actions.dismissMoveIssue.mutate()}>
                Dismiss
              </button>
            )}
          </p>
        )}
        {info.data && !info.data.gitAvailable && (
          <p className="kn-banner is-warn">
            Git isn’t available for Knowledge. Notes still save; history and undo are unavailable.
          </p>
        )}

        {section === 'files' && tree.data ? (
          <FilesView
            tree={tree.data}
            folder={filesFolder}
            agents={agents}
            onOpenPath={open}
            busy={flow.busy}
            onOpenFolder={setFilesFolder}
            onUpload={upload}
            onNewFolder={(parent) => openDialog({ kind: 'folder', parent })}
            onMove={(path) => openDialog({ kind: 'move', path })}
            onDelete={(path) => openDialog({ kind: 'delete', path })}
            exporting={exporter.busy}
            onExport={(request) => void exporter.run(request)}
            onDeleteFolder={(folder) =>
              actions.removeFolder.mutate(folder, {
                onSuccess: () => setNotice(`Deleted the folder ${folder}.`),
                onError: (error) => setNotice(knowledgeFailure(error, 'delete the folder')),
              })
            }
          />
        ) : active ? (
          <>
            <SelectedByline path={active} agents={agents} />
            {isNotePath(active) ? (
              <NoteWorkspace
                key={active}
                path={active}
                notes={notes}
                agents={agents}
                onOpenPath={open}
                external={external?.forPath === active ? external.event : null}
                onDismissExternal={() => setExternal(null)}
                onCreateLink={(target) =>
                  openDialog({
                    kind: 'new',
                    initial: pathForLinkTarget(target).replace(/\.md$/i, ''),
                  })
                }
                onMove={() => openDialog({ kind: 'move', path: active })}
                onDelete={() => openDialog({ kind: 'delete', path: active })}
                registerFlush={registerFlush}
              />
            ) : (
              <DocumentWorkspace
                key={active}
                path={active}
                agents={agents}
                onMove={() => openDialog({ kind: 'move', path: active })}
                onDelete={() => openDialog({ kind: 'delete', path: active })}
              />
            )}
          </>
        ) : (
          <div className="bold-library-blank">
            <BookIcon size={34} />
            <b>{tree.data?.notes.length === 0 ? 'The Library is empty' : 'Pick a note'}</b>
            <span>
              {tree.data?.notes.length === 0
                ? 'Start with a note, or upload files and folders.'
                : 'Choose one on the left, or search the whole vault.'}
            </span>
          </div>
        )}
      </section>

      {dialog?.kind === 'new' && (
        <NewNoteDialog
          initial={dialog.initial}
          busy={actions.save.isPending}
          error={dialogError}
          onSubmit={create}
          onClose={() => setDialog(null)}
        />
      )}
      {dialog?.kind === 'move' && (
        <MoveDialog
          from={dialog.path}
          document={!isNotePath(dialog.path)}
          busy={actions.move.isPending}
          error={dialogError}
          onClose={() => setDialog(null)}
          onSubmit={(to, updateLinks) => {
            const from = dialog.path
            void (
              from === active
                ? (flushRef.current?.() ?? Promise.resolve(true))
                : Promise.resolve(true)
            ).then((saved) => {
              if (!saved) {
                setDialogError(new UnsavedDraftError())
                return
              }
              move(from, to, updateLinks)
            })
          }}
        />
      )}
      {dialog?.kind === 'delete' && (
        <DeleteDialog
          path={dialog.path}
          document={!isNotePath(dialog.path)}
          busy={actions.remove.isPending || actions.removeDocument.isPending}
          error={dialogError}
          onClose={() => setDialog(null)}
          onConfirm={() => {
            const target = dialog.path
            const mutation = isNotePath(target) ? actions.remove : actions.removeDocument
            mutation.mutate(target, {
              onSuccess: () => {
                setDialog(null)
                setNotice(`Deleted ${target}.`)
                if (target === active) setSelected(null)
              },
              onError: setDialogError,
            })
          }}
        />
      )}
      {dialog?.kind === 'folder' && (
        <NewFolderDialog
          parent={dialog.parent}
          busy={actions.createFolder.isPending}
          error={dialogError}
          onClose={() => setDialog(null)}
          onSubmit={(folder) =>
            actions.createFolder.mutate(folder, {
              onSuccess: () => {
                setDialog(null)
                setFilesFolder(folder)
                setSection('files')
              },
              onError: setDialogError,
            })
          }
        />
      )}
      {exportRequest && (
        <ExportDialog
          heading={exportRequest.heading}
          request={exportRequest.request}
          busy={exporter.busy}
          onClose={() => setExportRequest(null)}
          onExport={() =>
            void exporter.run(exportRequest.request).then((ok) => {
              if (ok) setExportRequest(null)
            })
          }
        />
      )}
      {flow.dialogs}
    </div>
  )
}
