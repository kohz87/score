import type {
  AgentSummary,
  KnowledgeChanged,
  KnowledgeHistoryStatus,
  KnowledgeNote,
  KnowledgeNoteSummary,
} from '@score/contract'
import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState } from 'react'
import { Link, useNavigate } from 'react-router'
import { ApiError } from '../../data/api.ts'
import type { EditorState } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import { EditorToolbar } from './EditorToolbar.tsx'
import { MarkdownEditor } from './MarkdownEditor.tsx'
import { NotePanels, AuthorLabel, DiffView } from './NotePanels.tsx'
import {
  conflictOf,
  fetchNote,
  historyKey,
  knowledgeFailure,
  noteKey,
  orphanDrafts,
  saveNote,
  useHistory,
  useKnowledgeActions,
  useNote,
} from './knowledge-queries.ts'
import { noteDownloadHref } from './knowledge-export.ts'
import { noteUrl, timeAgo } from './knowledge-paths.ts'
import { readSource, writeSource } from './note-mode.ts'
import { resolveTarget } from './wikilinks.ts'

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
  /** Lets the page save the open draft before it moves the note. */
  registerFlush: (flush: (() => Promise<boolean>) | null) => void
}

export function NoteWorkspace(props: Props) {
  const note = useNote(props.path)
  const [session, setSession] = useState<Session | null>(null)
  if (note.data && session === null)
    setSession({ body: note.data.body, etag: note.data.etag, version: 0 })

  // A failed *refresh* keeps the pane (and the text in it); only a note that never opened gets the error screen.
  if (note.isError && session === null) {
    const missing = note.error instanceof ApiError && note.error.status === 404
    return (
      <div className="kn-empty" role="alert">
        <h2>{missing ? 'This note doesn’t exist' : 'Couldn’t open this note'}</h2>
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
    <>
      {note.isError && (
        <p role="alert" className="kn-banner is-warn">
          {knowledgeFailure(note.error, 'refresh the note')} Your text is still here.
        </p>
      )}
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
    </>
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
  registerFlush,
  note,
  session,
  reload,
}: Props & {
  note: KnowledgeNote
  session: Session
  reload: (beforeSwap: () => void) => Promise<void>
}) {
  const queryClient = useQueryClient()
  // Text an earlier editor of this note could not save: it comes back instead of the disk text.
  const [orphan] = useState(() => orphanDrafts.get(path))
  useEffect(() => {
    orphanDrafts.delete(path)
  }, [path])
  // One editor: formatted everywhere, raw Markdown on the caret's line. Source shows plain Markdown instead.
  const [source, setSource] = useState(readSource)
  const toggleSource = () => {
    setSource(!source)
    writeSource(!source)
  }
  const navigate = useNavigate()
  const [editor, setEditor] = useState<EditorView | null>(null)
  const [editorState, setEditorState] = useState<EditorState | null>(null)
  const [imageNotice, setImageNotice] = useState<string | null>(null)
  const [linkRequest, setLinkRequest] = useState(0)
  const [draft, setDraft] = useState(orphan?.body ?? session.body)
  const [status, setStatus] = useState<Status>(orphan ? 'dirty' : 'saved')
  const [changedElsewhere, setChangedElsewhere] = useState(false)
  const [saveError, setSaveError] = useState<unknown>(null)
  // The last save landed but git refused to record it (other than an ignore rule).
  // What the last save did to history; `failed` offers a retry, `git_unavailable` explains why there is none.
  const [historyStatus, setHistoryStatus] = useState<KnowledgeHistoryStatus>('committed')
  const [conflict, setConflict] = useState<{ etag: string | null } | null>(
    orphan && orphan.etag !== session.etag ? { etag: session.etag } : null,
  )
  const [compare, setCompare] = useState<KnowledgeNote | 'loading' | 'removed' | null>(null)
  const [reloadError, setReloadError] = useState(false)
  const draftRef = useRef(orphan?.body ?? session.body)
  const savedRef = useRef(session.body)
  const etagRef = useRef<string | null>(session.etag)
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  const inFlight = useRef(false)
  const saving = useRef<Promise<void> | null>(null)
  const saves = useRef(0)
  const failed = useRef(false)
  const unmounted = useRef(false)
  const conflictRef = useRef(orphan !== undefined && orphan.etag !== session.etag)
  const notesRef = useRef(notes)
  useEffect(() => {
    notesRef.current = notes
  })

  const refreshPanels = useCallback(() => {
    void queryClient.invalidateQueries({ queryKey: noteKey(path) })
    void queryClient.invalidateQueries({ queryKey: historyKey(path) })
  }, [queryClient, path])

  const saveRef = useRef<(overrideEtag?: string | null) => Promise<void>>(async () => undefined)
  const save = useCallback(
    (overrideEtag?: string | null): Promise<void> => {
      if (inFlight.current) return saving.current ?? Promise.resolve()
      if (conflictRef.current && overrideEtag === undefined) return Promise.resolve()
      const body = draftRef.current
      if (body === savedRef.current && overrideEtag === undefined) {
        setStatus('saved')
        return Promise.resolve()
      }
      inFlight.current = true
      failed.current = false
      setStatus('saving')
      // Not a mutation hook: a hook's callbacks stop once the editor is gone, and a save must outlive it.
      const task = (async () => {
        try {
          const response = await saveNote({
            path,
            body,
            etag: overrideEtag === undefined ? etagRef.current : overrideEtag,
          })
          inFlight.current = false
          saves.current += 1
          etagRef.current = response.etag
          savedRef.current = body
          conflictRef.current = false
          setConflict(null)
          setCompare(null)
          setSaveError(null)
          if (!unmounted.current) {
            setHistoryStatus(response.history)
            refreshPanels()
          }
          if (draftRef.current !== body) {
            if (unmounted.current) void saveRef.current()
            else {
              setStatus('dirty')
              timer.current = setTimeout(() => saveRef.current(), AUTOSAVE_MS)
            }
          } else setStatus('saved')
        } catch (error) {
          inFlight.current = false
          const stale = conflictOf(error)
          if (stale) {
            conflictRef.current = true
            setConflict(stale)
            setStatus('dirty')
          } else {
            failed.current = true
            setSaveError(error)
            setStatus('error')
          }
          if (unmounted.current)
            orphanDrafts.set(path, { body: draftRef.current, etag: etagRef.current })
        }
      })()
      saving.current = task
      return task
    },
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

  // Leaving the note (or the page) with unsaved text saves it once more. A save already running picks up what was
  // typed after it started once it lands; text that cannot be saved is kept for the next time the note opens.
  useEffect(() => {
    unmounted.current = false
    return () => {
      unmounted.current = true
      clearTimeout(timer.current)
      if (draftRef.current === savedRef.current || inFlight.current) return
      if (conflictRef.current)
        orphanDrafts.set(path, { body: draftRef.current, etag: etagRef.current })
      else void saveRef.current()
    }
  }, [path])

  useEffect(() => {
    if (orphan && !conflictRef.current)
      timer.current = setTimeout(() => saveRef.current(), AUTOSAVE_MS)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- only the draft this editor was opened with
  }, [])

  // The page asks for this before it moves the note: the draft is on disk (true) or it is not (false).
  useEffect(() => {
    registerFlush(async () => {
      clearTimeout(timer.current)
      for (let round = 0; round < 5; round += 1) {
        if (inFlight.current) await saving.current
        if (draftRef.current === savedRef.current) return true
        if (conflictRef.current) return false
        failed.current = false
        await saveRef.current()
        if (failed.current || conflictRef.current) return false
      }
      return draftRef.current === savedRef.current
    })
    return () => registerFlush(null)
  }, [registerFlush])

  // The note on disk moved on without us (another browser, a missed event, a stream resync): say so, never replace.
  useEffect(() => {
    if (note.etag === etagRef.current) return
    let cancelled = false
    void (async () => {
      while (inFlight.current) await saving.current
      const before = saves.current
      try {
        const fresh = await fetchNote(path)
        if (
          !cancelled &&
          saves.current === before &&
          !inFlight.current &&
          fresh.etag !== etagRef.current
        )
          setChangedElsewhere(true)
      } catch {
        // The failed refresh already shows its own message.
      }
    })()
    return () => {
      cancelled = true
    }
  }, [note.etag, path])

  async function doReload() {
    setReloadError(false)
    try {
      await reload(() => {
        // The pane is replaced by one holding the fresh text: nothing of this one may be saved on the way out.
        clearTimeout(timer.current)
        conflictRef.current = true
        setChangedElsewhere(false)
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

  function openWikilink(target: string) {
    const found = resolveTarget(target, note.links, notesRef.current)
    if (found) navigate(noteUrl(found))
    else onCreateLink(target)
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
            {!note.versioned && (
              <span className="kn-type-badge" data-testid="not-in-history">
                Not kept in history
              </span>
            )}
          </div>
          <div className="kn-actions">
            <button type="button" aria-pressed={source} onClick={toggleSource}>
              Source
            </button>
            <a className="kn-button" href={noteDownloadHref(path)} download>
              Download
            </a>
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
        {!note.versioned && (
          <p className="kn-banner" role="note">
            <span>
              <strong>Not kept in history.</strong> .gitignore excludes this folder, so Score saves
              the note but keeps no earlier versions. Saving or deleting it can’t be undone.
            </span>
          </p>
        )}
        {historyStatus === 'failed' && (
          <p className="kn-banner is-warn" role="status" data-testid="history-missed">
            <span>Saved, but history wasn’t updated. Your note is safe.</span>
            <button
              type="button"
              disabled={status === 'saving'}
              onClick={() => void save(etagRef.current)}
            >
              Save to history again
            </button>
          </p>
        )}
        {historyStatus === 'git_unavailable' && (
          <p className="kn-banner is-warn" role="status" data-testid="history-unavailable">
            Saved, but Knowledge history isn’t working, so this version isn’t recorded. Fix git in
            the Knowledge folder; the note stays as it is.
          </p>
        )}
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
        {changedElsewhere && !external && (
          <p className="kn-banner is-warn" role="status" data-testid="changed-elsewhere">
            This note changed somewhere else. Your text is unchanged ·{' '}
            <button type="button" onClick={() => void doReload()}>
              Reload
            </button>
          </p>
        )}
        {external?.kind === 'deleted' && (
          <p className="kn-banner is-warn" role="status">
            Deleted by <AuthorLabel author={external.by} agents={agents} />. Your text stays here
            until you leave. Save to create the note again.
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
            Couldn’t reload the note.
          </p>
        )}

        {conflict && (
          <div className="kn-banner is-warn" role="alert" data-testid="conflict">
            <p>
              <strong>This note changed somewhere else.</strong> Your edits are not saved yet.
              {!note.versioned && ' Overwriting replaces it for good: there is no earlier version.'}
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
            {compare === 'removed' && <p>The note was removed. Overwrite creates it again.</p>}
            {compare && typeof compare === 'object' && (
              <DiffView before={compare.body} after={draft} />
            )}
          </div>
        )}

        <EditorToolbar
          view={editor}
          state={editorState}
          notes={notes}
          notice={imageNotice}
          onNotice={setImageNotice}
          linkRequest={linkRequest}
        />
        <div className="kn-edit-area" data-source={source ? 'true' : undefined}>
          <MarkdownEditor
            key={`${path}:${session.version}`}
            initial={draft}
            label={`Contents of ${path}`}
            notes={() => notesRef.current}
            onChange={onChange}
            onOpenWikilink={openWikilink}
            isMissing={(target) => resolveTarget(target, note.links, notes) === null}
            refreshKey={`${notes.length}:${note.etag}`}
            source={source}
            onView={setEditor}
            onState={setEditorState}
            onNotice={setImageNotice}
            onShortcut={() => setLinkRequest((n) => n + 1)}
          />
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
