import { useState, type FormEvent } from 'react'
import type { HermesUpdateJob } from '@score/contract'
import { copyText } from '../../data/clipboard.ts'
import { useHermesCheck } from '../../routes/settings/settings-queries.ts'
import { problem } from './hermes-update-problem.tsx'

function CopyLine({ command }: { command: string }) {
  const [copied, setCopied] = useState(false)
  return (
    <span className="bold-hu-copy">
      <code>{command}</code>
      <button
        type="button"
        className="btn sm"
        aria-label={`Copy ${command}`}
        onClick={() =>
          void copyText(command).then((ok) => {
            if (ok) setCopied(true)
          })
        }
      >
        {copied ? 'Copied' : 'Copy'}
      </button>
    </span>
  )
}

const PART_STATUS = {
  same: 'Same',
  added: 'Added',
  changed: 'Changed',
  removed: 'Removed',
} as const

function Differs({ job, onDone }: { job: HermesUpdateJob; onDone: () => void }) {
  const { override } = useHermesCheck()
  const [password, setPassword] = useState('')
  const [on, setOn] = useState(false)
  const check = job.check
  if (!check) return null
  if (on) return <p role="status">Approvals are on for Hermes {job.toVersion ?? 'this version'}.</p>
  const parts = check.parts.filter((part) => part.status !== 'same')
  return (
    <form
      className="bold-hu-result"
      data-protected="block"
      data-tone="warn"
      aria-label="Turn approvals on anyway"
      onSubmit={(event: FormEvent) => {
        event.preventDefault()
        const typed = password
        setPassword('')
        override.mutate(
          { hash: check.hash, password: typed },
          {
            onSuccess: () => setOn(true),
          },
        )
      }}
    >
      <b className="bold-hu-title">Something Score relies on looks different</b>
      <table className="bold-hu-table">
        <thead>
          <tr>
            <th scope="col">Part</th>
            <th scope="col">Result</th>
            <th scope="col">Detail</th>
          </tr>
        </thead>
        <tbody>
          {parts.map((part) => (
            <tr key={part.name}>
              <th scope="row">{part.name}</th>
              <td>{PART_STATUS[part.status]}</td>
              <td>{part.detail}</td>
            </tr>
          ))}
          {job.test && (
            <tr>
              <th scope="row">Test message</th>
              <td>{job.test.ok ? 'Passed' : 'Failed'}</td>
              <td>{job.test.detail}</td>
            </tr>
          )}
        </tbody>
      </table>
      <p>
        Approvals are paused.{' '}
        {job.test?.ok
          ? 'The test passed, so you can turn them on anyway; '
          : 'You can turn them on anyway; '}
        Score hasn’t been tested with these changes, so approvals may show wrong details.
      </p>
      <label className="bold-hu-field">
        Security password
        <input
          type="password"
          autoComplete="current-password"
          required
          value={password}
          onChange={(event) => setPassword(event.target.value)}
        />
      </label>
      <div className="bold-hu-actions">
        <button type="submit" className="btn primary" disabled={override.isPending}>
          {override.isPending ? 'Turning on…' : 'Turn approvals on anyway'}
        </button>
        <button type="button" className="btn" onClick={onDone}>
          Stay paused
        </button>
      </div>
      {override.isError && <p role="alert">{problem(override.error, 'turn approvals on')}</p>}
    </form>
  )
}

export function Outcome({ job, onDone }: { job: HermesUpdateJob; onDone: () => void }) {
  if (job.outcome === 'clear')
    return (
      <p className="bold-hu-ok" role="status">
        <b>Hermes {job.toVersion ?? ''} works with Score.</b> Approvals are on.
      </p>
    )
  if (job.outcome === 'differs') return <Differs job={job} onDone={onDone} />
  if (job.outcome === 'broken') {
    const failedParts = (job.check?.parts ?? []).filter((part) => part.status !== 'same')
    const why =
      job.test && !job.test.ok
        ? job.test.detail
        : failedParts.map((part) => `${part.name}: ${part.detail}`).join(' ')
    return (
      <div className="bold-hu-result" data-protected="block" data-tone="bad">
        <b className="bold-hu-title">
          {job.test && !job.test.ok
            ? 'The test message failed'
            : 'This Hermes doesn’t work with Score'}
        </b>
        {why && <p>{why}</p>}
        <p>
          Approvals stay paused; chats may not work until Score is updated for this version.
          {job.backup
            ? ` Hermes saved a backup (${job.backup}) in its backups folder; Hermes keeps its last backups.`
            : ' Hermes keeps its last backups in its backups folder.'}
        </p>
        <p>To go back, run these in a terminal:</p>
        <CopyLine command="hermes update --channel stable" />
        <CopyLine
          command={`hermes import ~/.hermes/backups/${
            // Only a plain file name goes into a command someone will paste into a shell (review).
            job.backup && /^[\w.-]+$/.test(job.backup) ? job.backup : '<backup file>'
          } --force`}
        />
      </div>
    )
  }
  if (job.outcome === 'failed')
    return (
      <div className="bold-hu-result" data-protected="block" data-tone="bad" role="alert">
        <b className="bold-hu-title">The update didn’t finish</b>
        <p>{job.error ?? 'Hermes stopped before it finished.'}</p>
      </div>
    )
  return null
}
