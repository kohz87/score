import type { UploadProgress as Progress } from '../data/api.ts'
import './upload-progress.css'

const megabytes = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`

/** A long file name in a short form: the start and the extension survive ("quarterly-rep….pdf"). */
export function shortName(name: string, max = 32): string {
  if (name.length <= max) return name
  const dot = name.lastIndexOf('.')
  const extension = dot > 0 && name.length - dot <= 6 ? name.slice(dot) : ''
  return `${name.slice(0, max - extension.length - 1)}…${extension}`
}

/**
 * How far an upload has got: the bytes sent ("Uploading · 42% · 84.0 MB of 200.0 MB"), then `after`, the named step the
 * server is on once it has them all, with an indeterminate bar. `compact` is one line for a chip in a tray.
 */
export function UploadProgress({
  name,
  progress,
  after,
  compact = false,
}: {
  /** What is being sent; shown in a short form. Leave out when the surrounding text already says. */
  name?: string
  progress: Progress
  /** The server's step once everything is sent, e.g. "Checking the archive…". */
  after: string
  compact?: boolean
}) {
  const { loaded, total } = progress
  const sent = progress.done === true
  const percent = total > 0 ? Math.min(100, Math.round((loaded / total) * 100)) : 0
  const label = name ? shortName(name) : null
  const doing = sent ? after : 'Uploading'
  const aria = `${label ?? 'Upload'}: ${doing}`
  const bar = sent ? (
    <progress aria-label={aria} />
  ) : (
    <progress aria-label={aria} max={total} value={loaded} />
  )
  if (compact)
    return (
      <span className="upload-progress upload-progress-compact" role="status" aria-live="polite">
        <span>
          {label}
          {label && ' · '}
          {sent ? after : `${percent}%`}
        </span>
        {bar}
      </span>
    )
  return (
    <div className="upload-progress" role="status" aria-live="polite">
      {label && (
        <p>
          <strong>{label}</strong>
        </p>
      )}
      <p>
        {doing}
        {sent ? null : ` · ${percent}% · ${megabytes(loaded)} of ${megabytes(total)}`}
      </p>
      {bar}
    </div>
  )
}
