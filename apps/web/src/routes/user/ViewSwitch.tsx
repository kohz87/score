import { useEffect, useRef, useState, type FormEvent, type ReactNode } from 'react'
import { useLocation, useNavigate } from 'react-router'
import { apiFetch, ApiError } from '../../data/api.ts'
import { readGuard, saveView, userPathFor } from './user-view.ts'

/** What the person is told when the security password check fails (decision 87). */
export function passwordCheckProblem(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.status === 409 && error.code === 'password_not_set')
      return 'No security password is set yet. Set one in Settings › Remote first.'
    if (error.status === 429) return error.message
    if (error.code === 'wrong_password') return 'That is not the security password.'
  }
  return 'Couldn’t check the password. Try again.'
}

export async function checkSecurityPassword(password: string): Promise<void> {
  await apiFetch('session/security/check', {
    method: 'POST',
    body: JSON.stringify({ password }),
  })
}

/** Asks for the security password before the admin view opens, when this browser's guard is on. */
function AdminPasswordDialog({ onDone, onClose }: { onDone: () => void; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [password, setPassword] = useState('')
  const [problem, setProblem] = useState('')
  const [pending, setPending] = useState(false)
  useEffect(() => {
    dialog.current?.showModal?.()
  }, [])
  async function submit(event: FormEvent) {
    event.preventDefault()
    if (pending || !password) return
    setPending(true)
    setProblem('')
    try {
      await checkSecurityPassword(password)
      setPassword('')
      onDone()
    } catch (error) {
      setProblem(passwordCheckProblem(error))
      setPending(false)
    }
  }
  return (
    <dialog
      ref={dialog}
      open={typeof HTMLDialogElement.prototype.showModal !== 'function'}
      className="user-dialog"
      aria-labelledby="user-admin-title"
      onCancel={(event) => {
        event.preventDefault()
        onClose()
      }}
    >
      <form onSubmit={(event) => void submit(event)}>
        <h2 id="user-admin-title">Open the admin view</h2>
        <p className="user-muted">Type the security password to open the full interface.</p>
        <label className="user-field">
          <span>Security password</span>
          <input
            type="password"
            autoComplete="current-password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
          />
        </label>
        {problem && <p role="alert">{problem}</p>}
        <div className="user-dialog-actions">
          <button type="submit" className="user-primary" disabled={pending || !password}>
            {pending ? 'Checking…' : 'Open admin view'}
          </button>
          <button type="button" onClick={onClose}>
            Cancel
          </button>
        </div>
      </form>
    </dialog>
  )
}

/**
 * Switching between the two views (PLAN 8.4). The choice is remembered per browser. Going to the admin view asks for
 * the security password when this browser's guard is on; render `dialog` somewhere in the tree.
 */
export function useViewSwitch(): {
  toUser: () => void
  toAdmin: (path?: string) => void
  dialog: ReactNode
} {
  const navigate = useNavigate()
  const location = useLocation()
  const [asking, setAsking] = useState<string | null>(null)
  const open = (path: string) => {
    saveView('admin')
    void navigate(path)
  }
  return {
    toUser: () => {
      saveView('user')
      void navigate(userPathFor(location.pathname) ?? '/u')
    },
    toAdmin: (path = '/now') => {
      if (readGuard()) setAsking(path)
      else open(path)
    },
    dialog:
      asking === null ? null : (
        <AdminPasswordDialog
          onClose={() => setAsking(null)}
          onDone={() => {
            const path = asking
            setAsking(null)
            open(path)
          }}
        />
      ),
  }
}
