import type { KnowledgeChanged } from '@score/contract'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useParams } from 'react-router'
import { useStreamQuery } from '../../data/query-client.ts'
import { agentsQuery } from '../team/team-queries.ts'
import { DeleteDialog, MoveDialog, NewNoteDialog } from './KnowledgeDialogs.tsx'
import { KnowledgeTree } from './KnowledgeTree.tsx'
import { NoteWorkspace } from './NoteWorkspace.tsx'
import {
  UnsavedDraftError,
  useKnowledgeActions,
  useKnowledgeInfo,
  useKnowledgeLive,
  useKnowledgeTree,
  useSearch,
} from './knowledge-queries.ts'
import { baseName, noteUrl, pathForLinkTarget, timeAgo } from './knowledge-paths.ts'
import { splitSnippet } from './wikilinks.ts'
import './knowledge.css'

type Dialog = { kind: 'new'; initial: string } | { kind: 'move' } | { kind: 'delete' } | null

export function KnowledgePage() {
  const params = useParams()
  const path = params['*'] ? params['*'] : null
  const navigate = useNavigate()
  const info = useKnowledgeInfo()
  const tree = useKnowledgeTree()
  const agents = useStreamQuery(agentsQuery).data ?? []
  const actions = useKnowledgeActions()
  const [dialog, setDialog] = useState<Dialog>(null)
  const [dialogError, setDialogError] = useState<unknown>(null)
  const [notice, setNotice] = useState<string | null>(null)
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

  function move(to: string, updateLinks: boolean) {
    if (!path) return
    actions.move.mutate(
      { from: path, to, updateLinks },
      {
        onSuccess: (response) => {
          setDialog(null)
          setNotice(
            updateLinks
              ? `Moved to ${response.path}. Updated links in ${response.updatedNotes} ${response.updatedNotes === 1 ? 'note' : 'notes'}.`
              : `Moved to ${response.path}. Links in other notes were left as they are.`,
          )
          void navigate(noteUrl(response.path))
        },
        onError: setDialogError,
      },
    )
  }

  const searching = debounced !== '' || query.trim() !== ''
  return (
    <div className="kn-layout">
      <nav className="kn-left" aria-label="Notes">
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
                    <strong>{hit.title || baseName(hit.path)}</strong>
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
              {tree.data && <KnowledgeTree tree={tree.data} current={path} />}
            </section>
          </>
        )}
      </nav>

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
        {path ? (
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
            onMove={() => openDialog({ kind: 'move' })}
            onDelete={() => openDialog({ kind: 'delete' })}
            registerFlush={registerFlush}
          />
        ) : (
          <div className="kn-empty">
            <h2>Pick a note</h2>
            <p className="kn-muted">
              Choose one on the left, search with Ctrl+K, or start a new one with Ctrl+N.
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
      {dialog?.kind === 'move' && path && (
        <MoveDialog
          from={path}
          busy={actions.move.isPending}
          error={dialogError}
          onClose={() => setDialog(null)}
          onSubmit={(to, updateLinks) => {
            // The file moves as it is on disk, so unsaved text is saved first; if that fails nothing moves.
            void (flushRef.current?.() ?? Promise.resolve(true)).then((saved) => {
              if (!saved) {
                setDialogError(new UnsavedDraftError())
                return
              }
              move(to, updateLinks)
            })
          }}
        />
      )}
      {dialog?.kind === 'delete' && path && (
        <DeleteDialog
          path={path}
          busy={actions.remove.isPending}
          error={dialogError}
          onClose={() => setDialog(null)}
          onConfirm={() =>
            actions.remove.mutate(path, {
              onSuccess: () => {
                setDialog(null)
                setNotice(`Deleted ${path}.`)
                void navigate('/knowledge')
              },
              onError: setDialogError,
            })
          }
        />
      )}
    </div>
  )
}
