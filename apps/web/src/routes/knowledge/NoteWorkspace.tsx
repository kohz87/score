import type {
  AgentSummary,
  KnowledgeChanged,
  KnowledgeNote,
  KnowledgeNoteSummary,
} from '@score/contract'
import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link } from 'react-router'
import { ApiError } from '../../data/api.ts'
import { MarkdownEditor } from './MarkdownEditor.tsx'
import { NotePanels, AuthorLabel, DiffView } from './NotePanels.tsx'
import { NotePreview } from './NotePreview.tsx'
import {
  conflictOf,
  fetchNote,
  historyKey,
  knowledgeFailure,
  noteKey,
  useHistory,
  useKnowledgeActions,
  useNote,
} from './knowledge-queries.ts'
import { noteUrl, timeAgo } from './knowledge-paths.ts'

const AUTOSAVE_MS = 1000

type Session = { body: string; etag: string; version: number }
type Status = 'saved' | 'dirty' | 'saving' | 'error'

type Props = {
  path: string
  notes: KnowledgeNoteSummary[]
  agents: AgentSummary[]
  /** The latest `knowledge.changed` for this note that did not come from this browser. */
  external: KnowledgeChanged | null
  onDismissExternal: () => void
  onCreateLink: (target: string) => void
  onMove: () => void
  onDelete: () => void
}

export function NoteWorkspace(props: Props) {
  const note = useNote(props.path)
  const [session, setSession] = useState<Session | null>(null)
  if (note.data && session === null)
    setSession({ body: note.data.body, etag: note.data.etag, version: 0 })

  if (note.isError) {
    const missing = note.error instanceof ApiError && note.error.status === 404
    return (
      <div className="kn-empty" role="alert">
        <h2>{missing ? 'This note does not exist' : 'Could not open this note'}</h2>
        <p className="kn-muted">
          {missing
            ? 'It may have been moved or deleted.'
            : knowledgeFailure(note.error, 'open the note')}
        </p>
        {missing && (
          <button
            type="button"
            className="kn-primary"
            onClick={() => props.onCreateLink(props.path)}
          >
            Create {props.path}
          </button>
        )}
      </div>
    )
  }
  if (!note.data || session === null) return <p role="status">Opening note…</p>
  return (
    <Pane
      key={session.version}
      {...props}
      note={note.data}
      session={session}
      reload={async (beforeSwap) => {
        const fresh = await fetchNote(props.path)
        beforeSwap()
        setSession((previous) => ({
          body: fresh.body,
          etag: fresh.etag,
          version: (previous?.version ?? 0) + 1,
        }))
        void note.refetch()
      }}
    />
  )
}

function Pane({
  path,
  notes,
  agents,
  external,
  onDismissExternal,
  onCreateLink,
  onMove,
  onDelete,
  note,
  session,
  reload,
}: Props & {
  note: KnowledgeNote
  session: Session
  reload: (beforeSwap: () => void) => Promise<void>
}) {
  const queryClient = useQueryClient()
  const actions = useKnowledgeActions()
  const [mode, setMode] = useState<'edit' | 'preview'>('edit')
  const [draft, setDraft] = useState(session.body)
  const [status, setStatus] = useState<Status>('saved')
  const [saveError, setSaveError] = useState<unknown>(null)
  const [conflict, setConflict] = useState<{ etag: string | null } | null>(null)
  const [compare, setCompare] = useState<KnowledgeNote | 'loading' | 'removed' | null>(null)
  const [reloadError, setReloadError] = useState(false)
  const draftRef = useRef(session.body)
  const savedRef = useRef(session.body)
  const etagRef = useRef<string | null>(session.etag)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const inFlight = useRef(false)
  const conflictRef = useRef(false)
  const notesRef = useRef(notes)
  useEffect(() => {
    notesRef.current = notes
  })

  const refreshPanels = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: noteKey(path) })
    void queryClient.invalidateQueries({ queryKey: historyKey(path) })
  }, [queryClient, path])

  const saveRef = useRef<(overrideEtag?: string | null) => void>(() => undefined)
  const save = useCallback(
    (overrideEtag?: string | null) => {
      if (inFlight.current) return
      if (conflictRef.current && overrideEtag === undefined) return
      const body = draftRef.current
      if (body === savedRef.current && overrideEtag === undefined) {
        setStatus('saved')
        return
      }
      inFlight.current = true
      setStatus('saving')
      actions.save.mutate(
        { path, body, etag: overrideEtag === undefined ? etagRef.current : overrideEtag },
        {
          onSuccess: (response) => {
            inFlight.current = false
            etagRef.current = response.etag
            savedRef.current = body
            conflictRef.current = false
            setConflict(null)
            setCompare(null)
            setSaveError(null)
            refreshPanels()
            if (draftRef.current !== body) {
              setStatus('dirty')
              timer.current = setTimeout(() => saveRef.current(), AUTOSAVE_MS)
            } else setStatus('saved')
          },
          onError: (error) => {
            inFlight.current = false
            const stale = conflictOf(error)
            if (stale) {
              conflictRef.current = true
              setConflict(stale)
              setStatus('dirty')
            } else {
              setSaveError(error)
              setStatus('error')
            }
          },
        },
      )
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps -- `actions.save.mutate` is stable enough; the rest are refs
    [path, refreshPanels],
  )
  useEffect(() => {
    saveRef.current = save
  })

  const onChange = useCallback((text: string) => {
    draftRef.current = text
    setDraft(text)
    setStatus('dirty')
    clearTimeout(timer.current)
    timer.current = setTimeout(() => saveRef.current(), AUTOSAVE_MS)
  }, [])

  // Leaving the note (or the page) with unsaved text saves it once more.
  useEffect(
    () => () => {
      clearTimeout(timer.current)
      if (draftRef.current !== savedRef.current && !conflictRef.current) saveRef.current()
    },
    [],
  )

  async function doReload() {
    setReloadError(false)
    try {
      await reload(() => {
        // The pane is replaced by one holding the fresh text: nothing of this one may be saved on the way out.
        clearTimeout(timer.current)
        conflictRef.current = true
      })
    } catch {
      setReloadError(true)
    }
  }
  async function openCompare() {
    setCompare('loading')
    try {
      setCompare(await fetchNote(path))
    } catch (error) {
      setCompare(error instanceof ApiError && error.status === 404 ? 'removed' : null)
    }
  }

  // Agent edits: "edited by builder · 2 min ago" with Undo (= restore the commit before the agent's).
  const agentAuthor =
    note.lastAuthor && typeof note.lastAuthor === 'object' ? note.lastAuthor : null
  const history = useHistory(path, agentAuthor !== null)
  const previous = history.data?.[1]
  const restoreActions = useKnowledgeActions()

  return (
    <div className="kn-note">
      <section className="kn-note-main" aria-label="Editor">
        <header className="kn-note-head">
          <div>
            <h2>{note.title}</h2>
            <p className="kn-path">{path}</p>
          </div>
          <div className="kn-actions">
            <div role="group" aria-label="View" className="kn-toggle">
              <button type="button" aria-pressed={mode === 'edit'} onClick={() => setMode('edit')}>
                Edit
              </button>
              <button
                type="button"
                aria-pressed={mode === 'preview'}
                onClick={() => setMode('preview')}
              >
                Preview
              </button>
            </div>
            <button type="button" onClick={onMove}>
              Rename or move
            </button>
            <button type="button" onClick={onDelete}>
              Delete
            </button>
          </div>
        </header>

        <p className="kn-status" role="status" aria-live="polite">
          {status === 'saving'
            ? 'Saving…'
            : status === 'dirty'
              ? 'Unsaved changes'
              : status === 'error'
                ? 'Not saved'
                : 'Saved'}
        </p>
        {status === 'error' && (
          <p role="alert" className="kn-banner is-warn">
            {knowledgeFailure(saveError, 'save the note')}{' '}
            <button type="button" onClick={() => save()}>
              Try again
            </button>
          </p>
        )}

        {agentAuthor && (
          <p className="kn-banner" data-testid="agent-edit">
            Edited by <AuthorLabel author={agentAuthor} agents={agents} /> · {timeAgo(note.mtime)}
            {previous && (
              <>
                {' '}
                <button
                  type="button"
                  disabled={restoreActions.restore.isPending}
                  onClick={() =>
                    restoreActions.restore.mutate(
                      { path, commit: previous.commit },
                      { onSuccess: () => void doReload().then(refreshPanels) },
                    )
                  }
                >
                  Undo this change
                </button>
              </>
            )}
            {restoreActions.restore.isError && (
              <span role="alert"> {knowledgeFailure(restoreActions.restore.error, 'undo it')}</span>
            )}
          </p>
        )}

        {external && external.kind !== 'deleted' && external.kind !== 'moved' && (
          <p className="kn-banner is-warn" role="status">
            Changed by <AuthorLabel author={external.by} agents={agents} /> ·{' '}
            <button
              type="button"
              onClick={() => {
                void doReload()
                onDismissExternal()
              }}
            >
              Reload
            </button>
          </p>
        )}
        {external?.kind === 'deleted' && (
          <p className="kn-banner is-warn" role="status">
            Deleted by <AuthorLabel author={external.by} agents={agents} />. Your text stays here
            until you leave; saving it again creates the note anew.
          </p>
        )}
        {external?.kind === 'moved' && external.to && (
          <p className="kn-banner is-warn" role="status">
            Moved by <AuthorLabel author={external.by} agents={agents} /> ·{' '}
            <Link to={noteUrl(external.to)}>Open the new location</Link>
          </p>
        )}
        {reloadError && (
          <p role="alert" className="kn-banner is-warn">
            Could not reload the note.
          </p>
        )}

        {conflict && (
          <div className="kn-banner is-warn" role="alert" data-testid="conflict">
            <p>
              <strong>This note changed somewhere else.</strong> Your edits are not saved yet.
            </p>
            <div className="kn-actions">
              <button type="button" onClick={() => void doReload()}>
                Reload
              </button>
              <button type="button" onClick={() => save(conflict.etag)}>
                Overwrite
              </button>
              <button type="button" onClick={() => void openCompare()}>
                Compare
              </button>
            </div>
            {compare === 'loading' && <p role="status">Loading the other version…</p>}
            {compare === 'removed' && <p>The note was removed. Overwrite recreates it.</p>}
            {compare && typeof compare === 'object' && (
              <DiffView before={compare.body} after={draft} />
            )}
          </div>
        )}

        <div className="kn-edit-area">
          {mode === 'edit' ? (
            <MarkdownEditor
              key={`${path}:${session.version}`}
              initial={session.body}
              label={`Contents of ${path}`}
              notes={() => notesRef.current}
              onChange={onChange}
            />
          ) : (
            <NotePreview body={draft} links={note.links} notes={notes} onCreate={onCreateLink} />
          )}
        </div>
      </section>

      <NotePanels
        note={note}
        currentBody={draft}
        agents={agents}
        onRestored={() => void doReload()}
        onCreate={onCreateLink}
      />
    </div>
  )
}
