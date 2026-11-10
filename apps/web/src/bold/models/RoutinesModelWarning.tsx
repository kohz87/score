import type { RoutineSummary } from '@score/contract'

/**
 * Before the agent's own model changes while repeating jobs follow it (decision 182, mock-up 27-model-jobs): says which jobs
 * would change, and asks. Nothing changes until a button is pressed. A chat's `/model` never shows it: it touches no job.
 * It asks the person to decide, so it is a protected surface (`data-protected`).
 */
export function RoutinesModelWarning({
  agentName,
  current,
  next,
  jobs,
  busy,
  pinFailed,
  unreadable = false,
  onKeep,
  onChange,
  onCancel,
}: {
  agentName: string
  /** The model the agent has now, which "Keep the jobs" pins them to. */
  current: string
  next: string
  jobs: RoutineSummary[]
  busy: boolean
  /** Set when Hermes refused to pin a job: how many jobs were pinned before it stopped (from a re-read). */
  pinFailed: { pinned: number } | null
  /** Set when the jobs couldn't be read: the person may still change the model, knowing it isn't checked. */
  unreadable?: boolean
  onKeep: () => void
  onChange: () => void
  onCancel: () => void
}) {
  if (unreadable) {
    return (
      <div className="bold-model-jobs-warning" role="alert" data-protected="block">
        <h3>Couldn’t check whether repeating jobs follow {agentName}’s model.</h3>
        <p>
          If any do, they will run on {next} from their next run. Change it only if that is fine.
        </p>
        <div className="bold-model-jobs-actions">
          <button type="button" className="bold-model-jobs-keep" onClick={onChange}>
            Change anyway
          </button>
          <button type="button" onClick={onCancel}>
            Cancel
          </button>
        </div>
      </div>
    )
  }
  const following = jobs.filter((job) => !job.model)
  const pinned = jobs.filter((job) => job.model)
  const count = following.length
  return (
    <div className="bold-model-jobs-warning" role="alert" data-protected="block">
      <h3>
        {count} repeating {count === 1 ? 'job follows' : 'jobs follow'} {agentName}’s model
      </h3>
      <p>
        {following.map((job) => `${job.title} (${job.schedule})`).join(' and ')} will run on {next}{' '}
        from {count === 1 ? 'its' : 'their'} next run.
      </p>
      {pinned.length > 0 && (
        <ul>
          {pinned.map((job) => (
            <li key={job.id}>
              {job.title} is pinned to {job.model} and won’t change.
            </li>
          ))}
        </ul>
      )}
      {pinFailed && (
        <p role="alert">
          Hermes refused to pin a job, so {agentName}’s model wasn’t changed.
          {pinFailed.pinned > 0 &&
            ` ${pinFailed.pinned} ${pinFailed.pinned === 1 ? 'job was' : 'jobs were'} pinned before that and ${pinFailed.pinned === 1 ? 'keeps' : 'keep'} ${current}.`}
        </p>
      )}
      <div className="bold-model-jobs-actions">
        <button type="button" className="bold-model-jobs-keep" disabled={busy} onClick={onKeep}>
          Keep the jobs on {current}, then change
        </button>
        <button type="button" disabled={busy} onClick={onChange}>
          Change, jobs too
        </button>
        <button type="button" disabled={busy} onClick={onCancel}>
          Cancel
        </button>
      </div>
      <p className="bold-model-jobs-tip">
        Only want it for one conversation? Type <code>/model {next}</code> in that chat instead: the
        agent and its jobs stay as they are.
      </p>
    </div>
  )
}
