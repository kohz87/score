import type {
  AgentSummary,
  KnowledgeAuthor,
  KnowledgeChanged,
  KnowledgeHistoryStatus,
  KnowledgeNote,
} from '@score/contract'
import { Link } from 'react-router'
import { knowledgeFailure } from './knowledge-queries.ts'
import { noteUrl, timeAgo } from './knowledge-paths.ts'
import type { Status } from './note-workspace-types.ts'
import { AuthorLabel, DiffView } from './NotePanels.tsx'

export function NoteNotices({
  note,
  status,
  historyStatus,
  saveError,
  save,
  onSaveToHistory,
  agents,
  agentAuthor,
  previousCommit,
  restoring,
  restoreError,
  restoreFailed,
  onUndoAgent,
  external,
  onDismissExternal,
  changedElsewhere,
  reloadError,
  conflict,
  compare,
  draft,
  onReload,
  onCompare,
  onOpenPath,
}: {
  note: KnowledgeNote
  status: Status
  historyStatus: KnowledgeHistoryStatus
  saveError: unknown
  save: (overrideEtag?: string | null) => Promise<void>
  onSaveToHistory: () => void
  agents: AgentSummary[]
  agentAuthor: KnowledgeAuthor | null
  previousCommit: string | undefined
  restoring: boolean
  restoreError: unknown
  restoreFailed: boolean
  onUndoAgent: () => void
  external: KnowledgeChanged | null
  onDismissExternal: () => void
  changedElsewhere: boolean
  reloadError: boolean
  conflict: { etag: string | null } | null
  compare: KnowledgeNote | 'loading' | 'removed' | null
  draft: string
  onReload: () => void
  onCompare: () => void
  onOpenPath?: (path: string) => void
}) {
  return (
    <>
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
          <button type="button" disabled={status === 'saving'} onClick={onSaveToHistory}>
            Save to history again
          </button>
        </p>
      )}
      {historyStatus === 'git_unavailable' && (
        <p className="kn-banner is-warn" role="status" data-testid="history-unavailable">
          Saved, but Knowledge history isn’t working, so this version isn’t recorded. Fix git in the
          Knowledge folder; the note stays as it is.
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
          {previousCommit && (
            <>
              {' '}
              <button type="button" disabled={restoring} onClick={onUndoAgent}>
                Undo this change
              </button>
            </>
          )}
          {restoreFailed && <span role="alert"> {knowledgeFailure(restoreError, 'undo it')}</span>}
        </p>
      )}

      {external && external.kind !== 'deleted' && external.kind !== 'moved' && (
        <p className="kn-banner is-warn" role="status">
          Changed by <AuthorLabel author={external.by} agents={agents} /> ·{' '}
          <button
            type="button"
            onClick={() => {
              onReload()
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
          <button type="button" onClick={onReload}>
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
          {onOpenPath ? (
            <button
              type="button"
              className="kn-link-button"
              onClick={() => onOpenPath(external.to!)}
            >
              Open the new location
            </button>
          ) : (
            <Link to={noteUrl(external.to)}>Open the new location</Link>
          )}
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
            <button type="button" onClick={onReload}>
              Reload
            </button>
            <button type="button" onClick={() => save(conflict.etag)}>
              Overwrite
            </button>
            <button type="button" onClick={onCompare}>
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
    </>
  )
}
