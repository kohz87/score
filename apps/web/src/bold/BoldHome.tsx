import { useLocation } from 'react-router'
import { BoldFirstRun } from './BoldFirstRun.tsx'
import { BoldRoom } from './BoldRoom.tsx'
import { firstRunDone, shouldShowFirstRun } from './bold-first-run.ts'
import { useBoldTeamRoom } from './bold-search-queries.ts'

/** `/b`: the team room, or first run until this device has finished it and the room has a lead. */
export function BoldHome() {
  const location = useLocation()
  const forced = new URLSearchParams(location.search).get('first') === 'run'
  const team = useBoldTeamRoom()
  return shouldShowFirstRun(forced, firstRunDone(), team.data?.room) ? (
    <BoldFirstRun />
  ) : (
    <BoldRoom />
  )
}
