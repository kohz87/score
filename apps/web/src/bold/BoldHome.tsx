import { useState } from 'react'
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
  const read = firstRunView(forced, firstRunDone(), team.data?.room, team.isPending)
  // A room that is open stays open while its read is retried after a failure (the query reports pending again then):
  // unmounting it would drop what the person has open in the side panel, such as a run's decision half filled in.
  const [roomShown, setRoomShown] = useState(false)
  const view = read === 'loading' && roomShown ? 'room' : read
  if (view === 'room' && !roomShown) setRoomShown(true)
  // Recipes opens over `/b` (?recipes=1). The first-run page stays out from behind it, so none of it shows through the
  // backdrop or competes with the editor; closing Recipes (back to `/b`) brings first run back.
  const recipesOpen = new URLSearchParams(location.search).get('recipes') === '1'
  if (view === 'first-run' && recipesOpen)
    return <div className="bold-home-loading" aria-hidden="true" />
  if (view === 'first-run') return <BoldFirstRun />
  if (view === 'loading')
    return <div className="bold-home-loading" role="status" aria-label="Finding the team room" />
  return <BoldRoom />
}
