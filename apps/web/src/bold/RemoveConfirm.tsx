import { useEffect, useRef } from 'react'

/** The server's own words when it refuses (provider_in_use names the agents); a short fallback otherwise. */
export function removeProblem(error: unknown, what: string): string {
  if (error instanceof Error && error.message && 'code' in error && error.code !== 'request_failed')
    return error.message
  return `Couldn’t remove ${what}. Try again.`
}

/** Inline confirm for removing a connection. It asks the person to decide, so it is a protected surface. */
export function RemoveConfirm({
  what,
  text,
  pending,
  error,
  onCancel,
  onRemove,
}: {
  what: string
  text: string
  pending: boolean
  error: unknown
  onCancel: () => void
  onRemove: () => void
}) {
  const cancel = useRef<HTMLButtonElement>(null)
  useEffect(() => cancel.current?.focus(), [])
  return (
    <div
      className="bold-remove-confirm"
      data-protected="block"
      role="group"
      aria-label={`Remove ${what}`}
    >
      <p>{text}</p>
      {error != null && <p role="alert">{removeProblem(error, what)}</p>}
      <div className="row wrap">
        <button ref={cancel} type="button" className="btn sm" onClick={onCancel}>
          Cancel
        </button>
        <button type="button" className="btn sm primary" disabled={pending} onClick={onRemove}>
          {pending ? 'Removing…' : 'Remove'}
        </button>
      </div>
    </div>
  )
}

/** Focus an element once React has committed the change that put it (back) on the page. */
export function focusSoon(id: string) {
  window.setTimeout(() => document.getElementById(id)?.focus(), 0)
}
