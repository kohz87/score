import type { OrchestrationDetail } from '@score/contract'

export function PlanList({ run }: { run: OrchestrationDetail }) {
  if (run.plan.length === 0)
    return <p className="orch-muted">The lead hasn’t recorded a plan yet.</p>
  return (
    <ol className="orch-plan" aria-label="Plan">
      {run.plan.map((entry, index) => (
        <li key={index}>{entry}</li>
      ))}
    </ol>
  )
}
