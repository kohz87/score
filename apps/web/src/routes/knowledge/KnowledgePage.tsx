import type { KnowledgeChanged } from '@score/contract'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router'
import { ResponsiveDrawer } from '../../components/ResponsiveDrawer.tsx'
import { useStreamQuery } from '../../data/query-client.ts'
import { agentsQuery } from '../team/team-queries.ts'
import { DeleteDialog, MoveDialog, NewFolderDialog, NewNoteDialog } from './KnowledgeDialogs.tsx'
import { DocumentWorkspace } from './DocumentWorkspace.tsx'
import { FilesView } from './FilesView.tsx'
import { ACCEPT_FILES, isNotePath, TYPE_LABEL } from './knowledge-files.ts'
import { summaryText, useUploadFlow } from './UploadFlow.tsx'
import { KnowledgeTree } from './KnowledgeTree.tsx'
import { NoteWorkspace } from './NoteWorkspace.tsx'
import {
  knowledgeFailure,
  UnsavedDraftError,
  useKnowledgeActions,
  useKnowledgeInfo,
  useKnowledgeLive,
  useKnowledgeTree,
  useSearch,
} from './knowledge-queries.ts'
import { baseName, folderOf, noteUrl, pathForLinkTarget, timeAgo } from './knowledge-paths.ts'
import { splitSnippet } from './wikilinks.ts'
import './knowledge.css'

type Dialog =
  | { kind: 'new'; initial: string }
  | { kind: 'move'; path: string }
  | { kind: 'delete'; path: string }
  | { kind: 'folder'; parent: string }
  | null

export function KnowledgePage() {
  const params = useParams()
  const path = params['*'] ? params['*'] : null
  const navigate = useNavigate()
  const [searchParams, setSearchParams] = useSearchParams()
  // `?files=<folder>` shows the file manager for that folder (an empty value is the vault root).
  const filesFolder = searchParams.has('files') ? (searchParams.get('files') ?? '') : null
  const uploadInput = useRef<HTMLInputElement>(null)
  const [dragging, setDragging] = useState(false)
  const [notesOpen, setNotesOpen] = useState(false)
  const closeNotes = useCallback(() => setNotesOpen(false), [])
  const info = useKnowledgeInfo()
  const tree = useKnowledgeTree()
  const agents = useStreamQuery(agentsQuery).data ?? []
  const actions = useKnowledgeActions()
  const [dialog, setDialog] = useState<Dialog>(null)
  const [dialogError, setDialogError] = useState<unknown>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const flow = useUploadFlow((summary) => {
    const text = summaryText(summary)
    if (text) setNotice(text)
  })
  const [external, setExternal] = useState<{
    forPath: string | null
    event: KnowledgeChanged
  } | null>(null)
  const [query, setQuery] = useState('')
  const [debounced, setDebounced] = useState('')
  const searchRef = useRef<HTMLInputElement>(null)
  const flushRef = useRef<(() => Promise<boolean>) | null>(null)
  const registerFlush = useCallback((flush: (() => Promise<boolean>) | null) => {
    flushRef.current = flush
  }, [])
  const search = useSearch(debounced)
  const notes = useMemo(() => tree.data?.notes ?? [], [tree.data])
  const recent = useMemo(
    () => [...notes].sort((a, b) => b.mtime.localeCompare(a.mtime)).slice(0, 6),
    [notes],
  )

  useEffect(() => {
    const timer = setTimeout(() => setDebounced(query.trim()), 250)
    return () => clearTimeout(timer)
  }, [query])
  useKnowledgeLive((event) => {
    // Our own saves come back as `you`; the editor already has that text. Everything else is news for the open note.
    if (event.by !== 'you' && (event.path === path || (event.to !== null && event.to === path)))
      setExternal({ forPath: path, event })
  })

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if (!(event.metaKey || event.ctrlKey) || event.altKey) return
      const key = event.key.toLowerCase()
      if (key === 'k' && document.activeElement !== searchRef.current) {
        // Search first; pressing it again from the search box falls through to the command palette.
        event.preventDefault()
        event.stopImmediatePropagation()
        searchRef.current?.focus()
        searchRef.current?.select()
      } else if (key === 'n') {
        event.preventDefault()
        setDialogError(null)
        setDialog({ kind: 'new', initial: '' })
      }
    }
    // Capture phase on window: runs before the shell's Ctrl+K listener on the document.
    window.addEventListener('keydown', onKeyDown, true)
    return () => window.removeEventListener('keydown', onKeyDown, true)
  }, [])

  function openDialog(next: Dialog) {
    setDialogError(null)
    setDialog(next)
  }
  function create(newPath: string) {
    actions.save.mutate(
      { path: newPath, body: `# ${baseName(newPath)}\n\n`, etag: null },
      {
        onSuccess: (response) => {
          setDialog(null)
          void navigate(noteUrl(response.path))
        },
        onError: setDialogError,
      },
    )
  }

  function upload(files: File[], folder: string) {
    setDragging(false)
    if (files.length === 0) return
    void flow.start(
      files.map((file) => ({ name: file.name, blob: file })),
      folder,
    )
  }

  function move(from: string, to: string, updateLinks: boolean) {
    actions.move.mutate(
      { from, to, updateLinks },
      {
        onSuccess: (response) => {
          setDialog(null)
          setNotice(
            updateLinks
              ? `Moved to ${response.path}. Updated links in ${response.updatedNotes} ${response.updatedNotes === 1 ? 'note' : 'notes'}.`
              : `Moved to ${response.path}. Links in other notes were left as they are.`,
          )
          if (from === path) void navigate(noteUrl(response.path))
        },
        onError: setDialogError,
      },
    )
  }

  const searching = debounced !== '' || query.trim() !== ''
  return (
    <div
      className={`kn-layout${dragging ? ' is-dragging' : ''}`}
      onDragOver={(event) => {
        if (!event.dataTransfer.types.includes('Files')) return
        event.preventDefault()
        setDragging(true)
      }}
      onDragLeave={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDragging(false)
      }}
      onDrop={(event) => {
        if (!event.dataTransfer.types.includes('Files')) return
        event.preventDefault()
        upload([...event.dataTransfer.files], filesFolder ?? (path ? folderOf(path) : ''))
      }}
    >
      {dragging && (
        <p className="kn-drop-hint" role="status">
          Drop to add the files to{' '}
          <code>{(filesFolder ?? (path ? folderOf(path) : '')) || 'the vault'}</code>
        </p>
      )}
      <button
        type="button"
        className="kn-notes-toggle"
        aria-haspopup="dialog"
        aria-expanded={notesOpen}
        onClick={() => setNotesOpen(true)}
      >
        <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
          <path
            d="M2.5 4 H13.5 M2.5 8 H13.5 M2.5 12 H9"
            stroke="currentColor"
            strokeWidth="1.7"
            strokeLinecap="round"
          />
        </svg>
        All notes
      </button>
      <ResponsiveDrawer
        as="nav"
        label="Notes"
        className="kn-left"
        open={notesOpen}
        onClose={closeNotes}
      >
        <div className="kn-left-head">
          <h1>Knowledge</h1>
          <button
            type="button"
            className="kn-primary"
            onClick={() => openDialog({ kind: 'new', initial: '' })}
          >
            New note
          </button>
        </div>
        <div className="kn-left-tools">
          <Link
            to="/knowledge?files="
            className="kn-button"
            aria-current={filesFolder !== null ? 'page' : undefined}
          >
            Files
          </Link>
          <input
            ref={uploadInput}
            type="file"
            multiple
            hidden
            accept={ACCEPT_FILES}
            aria-label="Choose files to upload"
            onChange={(event) => {
              const files = [...(event.target.files ?? [])]
              event.target.value = ''
              upload(files, filesFolder ?? (path ? folderOf(path) : ''))
            }}
          />
          <button type="button" disabled={flow.busy} onClick={() => uploadInput.current?.click()}>
            {flow.busy ? 'Uploading…' : 'Upload'}
          </button>
        </div>
        <label className="kn-search">
          <span className="kn-sr">Search notes</span>
          <input
            ref={searchRef}
            type="search"
            placeholder="Search notes (Ctrl+K)"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
          />
        </label>
        {searching ? (
          <section aria-label="Search results">
            {search.isPending && debounced !== '' && <p role="status">Searching…</p>}
            {search.isError && <p role="alert">Search is not available right now.</p>}
            {search.data && search.data.length === 0 && (
              <p className="kn-muted">Nothing matches “{debounced}”.</p>
            )}
            <ul className="kn-results">
              {(search.data ?? []).map((hit) => (
                <li key={hit.path}>
                  <Link to={noteUrl(hit.path)} onClick={() => setQuery('')}>
                    <strong>
                      {hit.title || baseName(hit.path)}
                      {hit.kind === 'document' && hit.type && (
                        <span className="kn-type-badge">{TYPE_LABEL[hit.type]}</span>
                      )}
                    </strong>
                    <span className="kn-path">{hit.path}</span>
                    <span className="kn-snippet">
                      {splitSnippet(hit.snippet).map((part, index) =>
                        part.match ? <mark key={index}>{part.text}</mark> : part.text,
                      )}
                    </span>
                  </Link>
                </li>
              ))}
            </ul>
          </section>
        ) : (
          <>
            {recent.length > 0 && (
              <section aria-labelledby="kn-recent">
                <h2 id="kn-recent">Recent</h2>
                <ul className="kn-recent">
                  {recent.map((note) => (
                    <li key={note.path}>
                      <Link to={noteUrl(note.path)}>{note.title || baseName(note.path)}</Link>
                      <span className="kn-muted"> {timeAgo(note.mtime)}</span>
                    </li>
                  ))}
                </ul>
              </section>
            )}
            <section aria-labelledby="kn-all">
              <h2 id="kn-all">All notes</h2>
              {tree.isPending && <p role="status">Loading notes…</p>}
              {tree.isError && <p role="alert">Could not load the notes.</p>}
              {tree.data && <KnowledgeTree tree={tree.data} current={path} onDropFiles={upload} />}
            </section>
          </>
        )}
      </ResponsiveDrawer>

      <main className="kn-main" aria-label="Note">
        {notice && (
          <p className="kn-banner" role="status">
            {notice}{' '}
            <button type="button" onClick={() => setNotice(null)}>
              Dismiss
            </button>
          </p>
        )}
        {info.data && !info.data.gitAvailable && (
          <p className="kn-banner is-warn">
            Git is not available for this vault. Notes still save; history and undo are unavailable.
          </p>
        )}
        {path && !isNotePath(path) ? (
          <DocumentWorkspace
            key={path}
            path={path}
            agents={agents}
            onMove={() => openDialog({ kind: 'move', path })}
            onDelete={() => openDialog({ kind: 'delete', path })}
          />
        ) : path ? (
          <NoteWorkspace
            key={path}
            path={path}
            notes={notes}
            agents={agents}
            external={external?.forPath === path ? external.event : null}
            onDismissExternal={() => setExternal(null)}
            onCreateLink={(target) =>
              openDialog({ kind: 'new', initial: pathForLinkTarget(target).replace(/\.md$/i, '') })
            }
            onMove={() => openDialog({ kind: 'move', path })}
            onDelete={() => openDialog({ kind: 'delete', path })}
            registerFlush={registerFlush}
          />
        ) : filesFolder !== null && tree.data ? (
          <FilesView
            tree={tree.data}
            folder={filesFolder}
            agents={agents}
            busy={flow.busy}
            onOpenFolder={(folder) => setSearchParams({ files: folder })}
            onUpload={upload}
            onNewFolder={(parent) => openDialog({ kind: 'folder', parent })}
            onMove={(target) => openDialog({ kind: 'move', path: target })}
            onDelete={(target) => openDialog({ kind: 'delete', path: target })}
            onDeleteFolder={(folder) =>
              actions.removeFolder.mutate(folder, {
                onSuccess: () => setNotice(`Deleted the folder ${folder}.`),
                onError: (error) => setNotice(knowledgeFailure(error, 'delete the folder')),
              })
            }
          />
        ) : (
          <div className="kn-empty">
            <h2>Pick a note</h2>
            <p className="kn-muted">
              Choose one on the left, search with Ctrl+K, or start a new one with Ctrl+N. Drop files
              anywhere to add them, or open Files to manage them.
              {info.data && (
                <>
                  {' '}
                  {info.data.notes} {info.data.notes === 1 ? 'note' : 'notes'} in{' '}
                  <code>{info.data.vault}</code>.
                </>
              )}
            </p>
          </div>
        )}
      </main>

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
            // The file moves as it is on disk, so unsaved text is saved first; if that fails nothing moves.
            void (
              from === path
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
                if (target === path) void navigate('/knowledge')
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
                setSearchParams({ files: folder })
              },
              onError: setDialogError,
            })
          }
        />
      )}
      {flow.dialogs}
    </div>
  )
}
