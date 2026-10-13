import type { GlobalFence } from '@score/contract'
import { useState } from 'react'
import { describeOrchError, useLiftFence } from './orchestration-queries.ts'

/** The review screen: what may be missing from the database after a restore or a journal problem. */
export function FenceScreen({ fence }: { fence: GlobalFence }) {
  const lift = useLiftFence()
  const [reviewed, setReviewed] = useState(false)
  const [note, setNote] = useState('')
  // Score is holding all agent work (a copied home, a lost journal): only the command on the host leaves this state, so
  // there is no button to lift it (decision 71).
  const holding = fence.items.find((item) => item.ref === 'execution-frozen')
  if (holding)
    return (
      <section className="orch-decision orch-fence" aria-label="Score is holding agent work">
        <h3>Agent work is on hold</h3>
        <p role="status">{holding.detail}</p>
      </section>
    )
  return (
    <section className="orch-decision orch-fence" aria-label="Review before starting work">
      <h3>Starting work is blocked until you review this list</h3>
      <p>
        Score’s database doesn’t match the separate record it keeps of what it started
        {fence.reason ? ` (${fence.reason})` : ''}
        {fence.untrustedHistory ? '; the history can’t be trusted after a restore' : ''}. Runs that
        Score started may still be going in Hermes without Score knowing. No orchestration starts
        anything new until you lift this block.
      </p>
      {fence.items.length === 0 ? (
        <p className="orch-muted">No individual entries are listed.</p>
      ) : (
        <ul className="orch-fence-items" aria-label="Entries to review">
          {fence.items.map((item, index) => (
            <li key={`${item.kind}:${item.ref}:${index}`}>
              <strong>{item.kind}</strong> <span className="orch-mono">{item.ref}</span>
              <span> {item.detail}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="orch-muted">
        Record of what Score started: {fence.journal.ok ? 'readable' : 'not readable'},{' '}
        {fence.journal.entries} entries
        {fence.journal.sizeAlarm ? ', larger than expected' : ''}.
      </p>
      <label className="orch-check">
        <input
          type="checkbox"
          checked={reviewed}
          onChange={(event) => setReviewed(event.target.checked)}
        />
        I’ve been through this list. Lifting the block is recorded; it doesn’t prove that any run
        ended.
      </label>
      <label className="orch-field">
        <span>Note (optional)</span>
        <input value={note} maxLength={500} onChange={(event) => setNote(event.target.value)} />
      </label>
      <div className="orch-actions">
        <button
          type="button"
          className="orch-primary"
          disabled={!reviewed || lift.isPending}
          onClick={() =>
            lift.mutate({
              expectedRevision: fence.revision,
              reviewed: true,
              ...(note.trim() ? { note: note.trim() } : {}),
            })
          }
        >
          Lift the block
        </button>
      </div>
      {lift.isError && (
        <p role="alert" className="orch-error">
          {describeOrchError(lift.error)}
        </p>
      )}
    </section>
  )
}
