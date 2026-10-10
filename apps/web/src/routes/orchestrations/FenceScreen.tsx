import type { GlobalFence } from '@score/contract'
import { useState } from 'react'
import { describeOrchError, useLiftFence } from './orchestration-queries.ts'

/** The reconciliation screen: what may be missing from the database after a restore or a journal problem. */
export function FenceScreen({ fence }: { fence: GlobalFence }) {
  const lift = useLiftFence()
  const [reviewed, setReviewed] = useState(false)
  const [note, setNote] = useState('')
  return (
    <section className="orch-decision orch-fence" aria-label="Reconciliation">
      <h3>Starting work is blocked until you review this list</h3>
      <p>
        Score found a difference between its database and the execution journal it keeps outside it
        {fence.reason ? ` (${fence.reason})` : ''}
        {fence.untrustedHistory ? '; the history is marked untrusted after a restore' : ''}. Runs
        that Score started may still be going on in Hermes without Score knowing. Nothing new is
        started by any orchestration until you lift this.
      </p>
      {fence.items.length === 0 ? (
        <p className="orch-muted">No individual entries are listed.</p>
      ) : (
        <ul className="orch-fence-items" aria-label="Entries to reconcile">
          {fence.items.map((item, index) => (
            <li key={`${item.kind}:${item.ref}:${index}`}>
              <strong>{item.kind}</strong> <span className="orch-mono">{item.ref}</span>
              <span> {item.detail}</span>
            </li>
          ))}
        </ul>
      )}
      <p className="orch-muted">
        Journal: {fence.journal.ok ? 'readable' : 'not readable'}, {fence.journal.entries} entries
        {fence.journal.sizeAlarm ? ', larger than it should be' : ''}.
      </p>
      <label className="orch-check">
        <input
          type="checkbox"
          checked={reviewed}
          onChange={(event) => setReviewed(event.target.checked)}
        />
        I went through this list. Lifting the fence is recorded and is not proof that any run ended.
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
          Lift the fence
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
