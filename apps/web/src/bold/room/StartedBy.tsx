import type { Job } from '@score/contract'
import { ReportBackLine } from './ReportBack.tsx'

function sourceLink(value: string | null): string | null {
  if (!value) return null
  try {
    const url = new URL(value)
    return url.protocol === 'https:' || url.protocol === 'http:' ? url.toString() : null
  } catch {
    return null
  }
}

/** Where a trigger-started job came from. Its text is outside content, never an instruction to the agents. */
export function StartedBy({ job }: { job: Job }) {
  const source = job.source
  if (!source) return null
  const link = sourceLink(source.link)
  return (
    <article className="bold-source" data-protected="block" aria-label={`Started by ${source.app}`}>
      <span className="bold-source-head">
        Started by <b>{source.app}</b> through a trigger
      </span>
      <span className="bold-source-line">
        <span className="bold-source-badge">
          {source.app} · {source.ref}
        </span>
        {source.title && <span>{source.title}</span>}
      </span>
      {link && (
        <a className="bold-source-open" href={link} target="_blank" rel="noreferrer">
          Open in {source.app} ↗
        </a>
      )}
      {source.missing.length > 0 && (
        <span className="bold-source-missing">
          Missing from the call: {source.missing.join(', ')}
        </span>
      )}
      <ReportBackLine job={job} />
      <span className="bold-source-note">
        The ticket’s text reaches agents quoted as outside content, never as instructions.
      </span>
    </article>
  )
}
