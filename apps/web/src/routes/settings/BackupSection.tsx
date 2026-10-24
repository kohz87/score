import { useEffect, useRef } from 'react'
import { useLocation } from 'react-router'
import { FenceScreen } from '../orchestrations/FenceScreen.tsx'
import { useFence } from '../orchestrations/orchestration-queries.ts'
import '../orchestrations/orchestrations.css'

/** Settings › Backup: how to restore without hiding Hermes runs that Score started (orchestrations, PLAN 7.5). */
export function BackupSection({ heading = 'Backup and restore' }: { heading?: string } = {}) {
  const fence = useFence().data
  const location = useLocation()
  const review = useRef<HTMLDivElement>(null)
  // The Needs-you card links here (#global-fence); the fence arrives after the page, so land on it once it shows.
  useEffect(() => {
    if (location.hash !== '#global-fence' || !fence?.fenced) return
    review.current?.scrollIntoView?.({ block: 'start' })
    review.current?.focus({ preventScroll: true })
  }, [fence?.fenced, location.hash])
  return (
    <section id="backup" className="settings-card" aria-labelledby="settings-backup">
      <h2 id="settings-backup">{heading}</h2>
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
      {fence?.fenced ? (
        <div id="global-fence" ref={review} tabIndex={-1}>
          <FenceScreen fence={fence} />
        </div>
      ) : (
        <p>Nothing is blocked: Score’s record of runs matches its database.</p>
      )}
    </section>
  )
}
