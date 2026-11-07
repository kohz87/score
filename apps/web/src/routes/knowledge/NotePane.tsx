import type { EditorState } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import type { KnowledgeHistoryStatus, KnowledgeNote } from '@score/contract'
import { useQueryClient } from '@tanstack/react-query'
import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from 'react-router'
import { ApiError } from '../../data/api.ts'
import { EditorToolbar } from './EditorToolbar.tsx'
import {
  conflictOf,
  fetchNote,
  historyKey,
  noteKey,
  orphanDrafts,
  saveNote,
  useHistory,
  useKnowledgeActions,
} from './knowledge-queries.ts'
import { noteUrl } from './knowledge-paths.ts'
import { MarkdownEditor } from './MarkdownEditor.tsx'
import { readSource, writeSource } from './note-mode.ts'
import type { NoteWorkspaceProps, Session, Status } from './note-workspace-types.ts'
import { NoteHeader } from './NoteHeader.tsx'
import { NoteNotices } from './NoteNotices.tsx'
import { NotePanels } from './NotePanels.tsx'
import { resolveTarget } from './wikilinks.ts'

const AUTOSAVE_MS = 1000

export function Pane({
  path,
  notes,
  agents,
  onOpenPath,
  external,
  onDismissExternal,
  onCreateLink,
  onMove,
  onDelete,
  registerFlush,
  note,
  session,
  reload,
}: NoteWorkspaceProps & {
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
  // What the last save did to history; `failed` offers a retry, `git_unavailable` explains why there is none. It
  // starts from the note's own history status, so a failed commit is still shown after a reload.
  const [historyStatus, setHistoryStatus] = useState<KnowledgeHistoryStatus>(note.history)
  const [seenHistory, setSeenHistory] = useState(note.history)
  if (note.history !== seenHistory) {
    setSeenHistory(note.history)
    setHistoryStatus(note.history)
  }
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
    if (found) {
      if (onOpenPath) onOpenPath(found)
      else navigate(noteUrl(found))
    } else onCreateLink(target)
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
        <NoteHeader
          note={note}
          path={path}
          source={source}
          onToggleSource={toggleSource}
          onMove={onMove}
          onDelete={onDelete}
        />
        <NoteNotices
          note={note}
          status={status}
          historyStatus={historyStatus}
          saveError={saveError}
          save={save}
          onSaveToHistory={() => void save(etagRef.current)}
          agents={agents}
          agentAuthor={agentAuthor}
          previousCommit={previous?.commit}
          restoring={restoreActions.restore.isPending}
          restoreError={restoreActions.restore.error}
          restoreFailed={restoreActions.restore.isError}
          onUndoAgent={() => {
            if (!previous) return
            restoreActions.restore.mutate(
              { path, commit: previous.commit },
              { onSuccess: () => void doReload().then(refreshPanels) },
            )
          }}
          external={external}
          onDismissExternal={onDismissExternal}
          changedElsewhere={changedElsewhere}
          reloadError={reloadError}
          conflict={conflict}
          compare={compare}
          draft={draft}
          onReload={() => void doReload()}
          onCompare={() => void openCompare()}
          onOpenPath={onOpenPath}
        />

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
            tableKey={path}
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
        onOpenPath={onOpenPath}
        onRestored={() => void doReload()}
        onCreate={onCreateLink}
      />
    </div>
  )
}
