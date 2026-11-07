import type { KnowledgeNote } from '@score/contract'
import { noteDownloadHref } from './knowledge-export.ts'

export function NoteHeader({
  note,
  path,
  source,
  onToggleSource,
  onMove,
  onDelete,
}: {
  note: KnowledgeNote
  path: string
  source: boolean
  onToggleSource: () => void
  onMove: () => void
  onDelete: () => void
}) {
  return (
    <header className="kn-note-head">
      <div>
        <h2 tabIndex={-1}>{note.title}</h2>
        <p className="kn-path">{path}</p>
        {!note.versioned && (
          <span className="kn-type-badge" data-testid="not-in-history">
            Not kept in history
          </span>
        )}
      </div>
      <div className="kn-actions">
        <button type="button" aria-pressed={source} onClick={onToggleSource}>
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
  )
}
