import { Link } from 'react-router'
import { useFence } from '../orchestrations/orchestration-queries.ts'

/** Settings › Backup: how to restore without hiding Hermes runs that Score started (orchestrations, PLAN 7.5). */
export function BackupSection() {
  const fence = useFence().data
  return (
    <section id="backup" className="settings-card" aria-labelledby="settings-backup">
      <h2 id="settings-backup">Backup and restore</h2>
      <p>
        Orchestrations start Hermes runs on their own, so Score keeps an execution journal outside
        its home folder and compares it with the database on every start.
      </p>
      <p>
        Restore only with <code>scripts/score restore &lt;backup-folder&gt;</code> (Score stopped).
        A restore not done with <code>scripts/score restore</code> on the same host and boot
        can&apos;t be detected: Hermes runs that Score started after the backup was made are then
        unknown to Score and may still be running.
      </p>
      <p>
        {fence?.fenced ? (
          <>
            Starting orchestrated work is blocked right now.{' '}
            <Link to="/now">Review the reconciliation list on Now</Link>.
          </>
        ) : (
          'Nothing is blocked: the journal and the database agree.'
        )}
      </p>
    </section>
  )
}
