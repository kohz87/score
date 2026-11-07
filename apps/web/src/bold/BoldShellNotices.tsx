import { Link } from 'react-router'
import { useFence } from '../routes/orchestrations/orchestration-queries.ts'
import { needsHermesCheck, useSystemStatus } from '../routes/settings/settings-queries.ts'

/**
 * A restore or lost journal blocks every run. The room's Needs-you strip carries the card; every other page of the
 * shell says it here, so the person can't miss it wherever they are (the review itself is Settings › System).
 */
export function ShellFenceNotice({ pathname }: { pathname: string }) {
  const fence = useFence().data
  if (!fence?.fenced || pathname === '/b' || pathname === '/b/settings/system') return null
  return (
    <div className="bold-fence-notice" role="status" data-protected="flex">
      <span>Starting work is blocked until you review the runs it stopped.</span>
      <Link className="btn sm" to="/b/settings/system#global-fence">
        Review the runs
      </Link>
    </div>
  )
}

/**
 * An unchecked Hermes build pauses approvals in Score. Settings shows the check itself (HermesVersionBanner); every
 * other page says so here, so the person doesn't find out only when an approval never arrives.
 */
export function HermesCheckNotice({ pathname }: { pathname: string }) {
  const system = useSystemStatus()
  if (!needsHermesCheck(system.data) || pathname.startsWith('/b/settings')) return null
  return (
    <div className="bold-fence-notice" role="status" data-protected="flex">
      <span>Hermes was updated. Approvals in Score are paused until you check this version.</span>
      <Link className="btn sm" to="/b/settings/connections">
        Check this Hermes version
      </Link>
    </div>
  )
}
