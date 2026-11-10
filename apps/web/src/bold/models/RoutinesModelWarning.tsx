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
  failed,
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
  /** Set when pinning the jobs failed: nothing was changed. */
  failed: boolean
  onKeep: () => void
  onChange: () => void
  onCancel: () => void
}) {
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
      {failed && <p role="alert">Couldn’t keep the jobs on {current}. Nothing was changed.</p>}
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
