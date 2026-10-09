import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import { knowledgeFailure } from './knowledge-queries.ts'
import { baseName, normalizeNewPath } from './knowledge-paths.ts'

function Modal({
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
          Path in the vault
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

export function MoveDialog({
  from,
  busy,
  error,
  onSubmit,
  onClose,
}: {
  from: string
  busy: boolean
  error: unknown
  onSubmit: (to: string, updateLinks: boolean) => void
  onClose: () => void
}) {
  const [value, setValue] = useState(from)
  const [updateLinks, setUpdateLinks] = useState(true)
  const to = normalizeNewPath(value)
  return (
    <Modal title={`Rename or move ${baseName(from)}`} onClose={onClose}>
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
        <label className="kn-check">
          <input
            type="checkbox"
            checked={updateLinks}
            onChange={(event) => setUpdateLinks(event.target.checked)}
          />
          Update links in other notes
        </label>
        {error != null && <p role="alert">{knowledgeFailure(error, 'move the note')}</p>}
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
  busy,
  error,
  onConfirm,
  onClose,
}: {
  path: string
  busy: boolean
  error: unknown
  onConfirm: () => void
  onClose: () => void
}) {
  return (
    <Modal title={`Delete ${baseName(path)}?`} onClose={onClose}>
      <p>
        The note is removed from the vault. If git is available, its history keeps every earlier
        version.
      </p>
      {error != null && <p role="alert">{knowledgeFailure(error, 'delete the note')}</p>}
      <div className="kn-actions">
        <button type="button" className="kn-primary" disabled={busy} onClick={onConfirm}>
          {busy ? 'Deleting…' : 'Delete note'}
        </button>
        <button type="button" onClick={onClose}>
          Cancel
        </button>
      </div>
    </Modal>
  )
}
