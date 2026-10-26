import { Navigate, useLocation } from 'react-router'
import { BoldFirstRun } from './BoldFirstRun.tsx'
import { BoldRoom } from './BoldRoom.tsx'
import { firstRunDone, firstRunView } from './bold-first-run.ts'
import { useBoldTeamRoom } from './bold-search-queries.ts'

/** `/b`: the team room, or first run until this device has finished it and the room has a lead. */
export function BoldHome() {
  const location = useLocation()
  const forced = new URLSearchParams(location.search).get('first') === 'run'
  // `/b?recipes=1` was the recipe dialog; Recipes is a page now (2.8.0), and old links still land on it.
  const oldRecipesLink = new URLSearchParams(location.search).get('recipes') === '1'
  const team = useBoldTeamRoom()
  if (oldRecipesLink) return <Navigate to="/b/recipes" replace />
  const view = firstRunView(forced, firstRunDone(), team.data?.room, team.isPending)
  if (view === 'first-run') return <BoldFirstRun />
  if (view === 'loading')
    return <div className="bold-home-loading" role="status" aria-label="Finding the team room" />
  return <BoldRoom />
}
