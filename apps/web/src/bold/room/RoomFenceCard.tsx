import { Link } from 'react-router'
import { useFence } from '../../routes/orchestrations/orchestration-queries.ts'
import { PinCard } from './PinCards.tsx'

/** A restore or lost journal blocks every run: the room says so and opens the review that can lift it. */
export function RoomFence() {
  const fence = useFence().data
  if (!fence?.fenced) return null
  return (
    <PinCard
      pinKey="global-fence"
      since={fence.since ?? ''}
      label="Starting work is blocked until you review the runs it stopped"
      variant="run-request"
    >
      <div className="bold-request-head">
        <b>Runs stopped</b>
      </div>
      <b className="bold-request-title">
        Starting work is blocked until you review the runs it stopped
      </b>
      <span>
        Score’s database and its separate record of what it started disagree. Nothing new starts
        until you review the list.
      </span>
      <div className="row">
        <Link className="btn sm" to="/b/settings/system#global-fence">
          Review the runs
        </Link>
      </div>
    </PinCard>
  )
}
