import { useLocation } from 'react-router'
import { BoldFirstRun } from './BoldFirstRun.tsx'
import { BoldRoom } from './BoldRoom.tsx'
import { firstRunDone, firstRunView } from './bold-first-run.ts'
import { useBoldTeamRoom } from './bold-search-queries.ts'

/** `/b`: the team room, or first run until this device has finished it and the room has a lead. */
export function BoldHome() {
  const location = useLocation()
  const forced = new URLSearchParams(location.search).get('first') === 'run'
  const team = useBoldTeamRoom()
  const view = firstRunView(forced, firstRunDone(), team.data?.room, team.isPending)
  if (view === 'first-run') return <BoldFirstRun />
  if (view === 'loading')
    return <div className="bold-home-loading" role="status" aria-label="Finding the team room" />
  return <BoldRoom />
}
