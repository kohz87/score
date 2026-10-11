import { Link } from 'react-router'
import { useFence } from '../orchestrations/orchestration-queries.ts'

/** Settings › Backup: how to restore without hiding Hermes runs that Score started (orchestrations, PLAN 7.5). */
export function BackupSection() {
  const fence = useFence().data
  return (
    <section id="backup" className="settings-card" aria-labelledby="settings-backup">
      <h2 id="settings-backup">Backup and restore</h2>
      <p>
        Orchestrations start Hermes runs on their own. Score keeps a separate record of those runs
        outside its home folder and compares it with its database each time it starts.
      </p>
      <p>
        Restore only with <code>scripts/score restore &lt;backup-folder&gt;</code> while Score is
        stopped. Score can’t detect a restore done any other way on the same machine and boot:
        Hermes runs that Score started after the backup was made would be unknown to it and might
        still be running.
      </p>
      <p>
        {fence?.fenced ? (
          <>
            Orchestrations can’t start right now.{' '}
            <Link to="/now">Check the runs waiting for review on Now</Link>.
          </>
        ) : (
          'Nothing is blocked: Score’s record of runs matches its database.'
        )}
      </p>
    </section>
  )
}
