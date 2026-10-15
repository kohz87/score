import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import { knowledgeFailure, useNote } from './knowledge-queries.ts'
import { baseName, normalizeNewPath } from './knowledge-paths.ts'

export function Modal({
  title,
  onClose,
  children,
}: {
  title: string
  onClose: () => void
  children: ReactNode
}) {
  const titleId = useId()
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    ref.current?.querySelector<HTMLElement>('input, button')?.focus()
  }, [])
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault()
      onClose()
    } else if (event.key === 'Tab') {
      const controls = ref.current?.querySelectorAll<HTMLElement>(
        'input, button:not(:disabled), a[href]',
      )
      const first = controls?.[0]
      const last = controls?.[controls.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last?.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first?.focus()
      }
    }
  }
  return (
    <div
      className="kn-backdrop"
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        ref={ref}
        className="kn-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        onKeyDown={onKeyDown}
      >
        <h2 id={titleId}>{title}</h2>
        {children}
      </div>
    </div>
  )
}

export function NewNoteDialog({
  initial,
  busy,
  error,
  onSubmit,
  onClose,
}: {
  initial: string
  busy: boolean
  error: unknown
  onSubmit: (path: string) => void
  onClose: () => void
}) {
  const [value, setValue] = useState(initial)
  const path = normalizeNewPath(value)
  function submit(event: FormEvent) {
    event.preventDefault()
    if (path) onSubmit(path)
  }
  return (
    <Modal title="New note" onClose={onClose}>
      <form onSubmit={submit}>
        <label>
          Path in Knowledge
          <input
            value={value}
            maxLength={500}
            placeholder="projects/ideas/launch plan"
            onChange={(event) => setValue(event.target.value)}
          />
        </label>
        <p className="kn-muted">
          Folders are created as needed. <code>.md</code> is added for you.
        </p>
        {error != null && <p role="alert">{knowledgeFailure(error, 'create the note')}</p>}
        <div className="kn-actions">
          <button type="submit" className="kn-primary" disabled={!path || busy}>
            {busy ? 'Creating…' : 'Create note'}
          </button>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </Modal>
  )
}

/** What the person types for a document's new path: trimmed, no leading slash, the file type stays as typed. */
function normalizeFilePath(input: string): string | null {
  const cleaned = input
    .trim()
    .replace(/^\/+/, '')
    .replace(/\/{2,}/g, '/')
  return !cleaned || cleaned.endsWith('/') ? null : cleaned
}

export function MoveDialog({
  from,
  document = false,
  busy,
  error,
  onSubmit,
  onClose,
}: {
  from: string
  /** A document (PDF, ...) rather than a note: the file type is kept and there are no links to update. */
  document?: boolean
  busy: boolean
  error: unknown
  onSubmit: (to: string, updateLinks: boolean) => void
  onClose: () => void
}) {
  const [value, setValue] = useState(from)
  const [updateLinks, setUpdateLinks] = useState(true)
  const to = document ? normalizeFilePath(value) : normalizeNewPath(value)
  return (
    <Modal
      title={`Rename or move ${document ? from.split('/').pop() : baseName(from)}`}
      onClose={onClose}
    >
      <form
        onSubmit={(event) => {
          event.preventDefault()
          if (to && to !== from) onSubmit(to, updateLinks)
        }}
      >
        <label>
          New path
          <input value={value} maxLength={500} onChange={(event) => setValue(event.target.value)} />
        </label>
        {!document && (
          <label className="kn-check">
            <input
              type="checkbox"
              checked={updateLinks}
              onChange={(event) => setUpdateLinks(event.target.checked)}
            />
            Update links in other notes
          </label>
        )}
        {error != null && (
          <p role="alert">
            {knowledgeFailure(error, document ? 'move the file' : 'move the note')}
          </p>
        )}
        <div className="kn-actions">
          <button type="submit" className="kn-primary" disabled={!to || to === from || busy}>
            {busy ? 'Moving…' : 'Move'}
          </button>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </Modal>
  )
}

export function DeleteDialog({
  path,
  document = false,
  busy,
  error,
  onConfirm,
  onClose,
}: {
  path: string
  document?: boolean
  busy: boolean
  error: unknown
  onConfirm: () => void
  onClose: () => void
}) {
  // The open note is already cached; a note outside history has no earlier version to fall back on.
  const note = useNote(document ? null : path)
  const unversioned = note.data?.versioned === false
  return (
    <Modal title={`Delete ${document ? path.split('/').pop() : baseName(path)}?`} onClose={onClose}>
      <p>
        {document
          ? 'The file is removed from Knowledge. If it is versioned in git (files up to 10 MB), its history keeps the last version; larger files are gone for good.'
          : unversioned
            ? 'The note is removed from Knowledge. There is no earlier version to restore: .gitignore excludes this folder, so Score doesn’t keep it in history.'
            : 'The note is removed from Knowledge. If git is available, its history keeps every earlier version.'}
      </p>
      {error != null && (
        <p role="alert">
          {knowledgeFailure(error, document ? 'delete the file' : 'delete the note')}
        </p>
      )}
      <div className="kn-actions">
        <button type="button" className="kn-primary" disabled={busy} onClick={onConfirm}>
          {busy ? 'Deleting…' : document ? 'Delete file' : 'Delete note'}
        </button>
        <button type="button" onClick={onClose}>
          Cancel
        </button>
      </div>
    </Modal>
  )
}

export function NewFolderDialog({
  parent,
  busy,
  error,
  onSubmit,
  onClose,
}: {
  parent: string
  busy: boolean
  error: unknown
  onSubmit: (path: string) => void
  onClose: () => void
}) {
  const [value, setValue] = useState(parent === '' ? '' : `${parent}/`)
  const path = normalizeFilePath(value)
  return (
    <Modal title="New folder" onClose={onClose}>
      <form
        onSubmit={(event) => {
          event.preventDefault()
          if (path) onSubmit(path)
        }}
      >
        <label>
          Folder path
          <input
            value={value}
            maxLength={500}
            placeholder="projects/contracts"
            onChange={(event) => setValue(event.target.value)}
          />
        </label>
        {error != null && <p role="alert">{knowledgeFailure(error, 'create the folder')}</p>}
        <div className="kn-actions">
          <button type="submit" className="kn-primary" disabled={!path || busy}>
            {busy ? 'Creating…' : 'Create folder'}
          </button>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </Modal>
  )
}
