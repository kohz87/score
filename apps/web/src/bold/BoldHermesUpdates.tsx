import { useEffect, useState } from 'react'
import { useStreamQuery } from '../data/query-client.ts'
import { agentsQuery } from '../routes/chat/queries.ts'
import { useSystemStatus } from '../routes/settings/settings-queries.ts'
import {
  readChannel,
  rememberChannel,
  useHermesUpdateActions,
  useHermesUpdateStatus,
} from './hermes-update-queries.ts'
import { Outcome } from './hermes-updates/Outcome.tsx'
import { problem } from './hermes-updates/hermes-update-problem.tsx'
import { Progress } from './hermes-updates/Progress.tsx'
import { UpdateDialog } from './hermes-updates/UpdateDialog.tsx'
import './bold-hermes-updates.css'

/** Settings › System: update Hermes, with a backup, Score's check and a test message (3.15.0, owner). */
export function BoldHermesUpdates() {
  const status = useHermesUpdateStatus()
  const system = useSystemStatus()
  const agents = useStreamQuery(agentsQuery).data ?? []
  const { check } = useHermesUpdateActions()
  const [channel, setChannel] = useState(readChannel)
  const [open, setOpen] = useState(false)
  const [dismissed, setDismissed] = useState<string | null>(null)
  const data = status.data
  const job = data?.job ?? null
  const checked = check.data ?? (data?.lastCheck?.channel === channel ? data.lastCheck : null)
  // A finished job stays until the next check (or until the person closes it).
  const jobShown =
    job != null &&
    dismissed !== job.id &&
    (job.state === 'running' ||
      !data?.lastCheck ||
      !job.endedAt ||
      data.lastCheck.checkedAt <= job.endedAt)
  const running = job?.state === 'running'
  // The Connections banner links here: bring the card into view (the router doesn't scroll to a hash; review).
  useEffect(() => {
    if (window.location.hash === '#hermes-updates')
      document.getElementById('hermes-updates')?.scrollIntoView?.({ block: 'start' })
  }, [])

  return (
    <section
      className="card bold-hu span2"
      aria-labelledby="system-hermes-updates"
      id="hermes-updates"
    >
      <h3 id="system-hermes-updates">Hermes updates</h3>
      {status.isPending && <p className="small muted">Loading…</p>}
      {status.isError && <p role="alert">Couldn’t load the Hermes update status.</p>}
      {data && !data.available && (
        <p className="small muted">Updating Hermes isn’t available here.</p>
      )}
      {data?.available && (
        <>
          <div className="bold-hu-facts">
            <div>
              <span className="small muted">Version</span>
              <b>{data.version ?? 'unknown'}</b>
            </div>
            <div>
              <label htmlFor="hermes-channel" className="small muted">
                Update channel
              </label>
              <select
                id="hermes-channel"
                className="field"
                value={channel}
                disabled={running}
                onChange={(event) => {
                  const next = event.target.value === 'stable' ? 'stable' : 'main'
                  setChannel(next)
                  rememberChannel(next)
                  check.reset()
                }}
              >
                <option value="stable">Stable releases</option>
                <option value="main">Every change (main)</option>
              </select>
            </div>
            <div>
              <span className="small muted">Score’s check</span>
              <b data-ok={system.data?.compatibility.tested ? 'true' : 'false'}>
                {!system.data
                  ? '…'
                  : system.data.compatibility.tested
                    ? 'Tested'
                    : 'Approvals paused'}
              </b>
            </div>
          </div>

          {job && jobShown && (
            <>
              <Progress job={job} agents={agents} />
              {job.state === 'finished' && (
                <Outcome job={job} onDone={() => setDismissed(job.id)} />
              )}
            </>
          )}

          {!running && !open && (
            <>
              {checked && (
                <div className="bold-hu-found" role="status">
                  <b>{checked.summary}</b>
                  {checked.restarts.length > 0 && (
                    <span>Restarts: {checked.restarts.join(', ')}</span>
                  )}
                </div>
              )}
              <div className="bold-hu-actions">
                <button
                  type="button"
                  className="btn"
                  disabled={check.isPending}
                  onClick={() =>
                    check.mutate(channel, {
                      onSuccess: () => {
                        if (job) setDismissed(job.id)
                      },
                    })
                  }
                >
                  {check.isPending
                    ? 'Checking…'
                    : checked
                      ? 'Check again'
                      : 'Check for Hermes updates'}
                </button>
                {checked?.available && (
                  <button type="button" className="btn primary" onClick={() => setOpen(true)}>
                    Update Hermes…
                  </button>
                )}
              </div>
              {check.isError && <p role="alert">{problem(check.error, 'check for updates')}</p>}
            </>
          )}

          {open && !running && (
            <UpdateDialog
              status={data}
              channel={channel}
              agents={agents}
              onClose={() => setOpen(false)}
            />
          )}
        </>
      )}
    </section>
  )
}
