import type { WorkflowRunDetail } from '@score/contract'
import { RunControls } from '../../routes/orchestrations/RunPanel.tsx'
import { useRun, useRunActions } from '../../routes/orchestrations/orchestration-queries.ts'
import { useWorkflowRun, useWorkflowRunActions } from '../../routes/workflows/workflow-queries.ts'
import { ClassicPaper } from '../ClassicPaper.tsx'
import type { JobRecipe } from '../room/thread-model.ts'

/** An agent the run was started with that has since been replaced or removed: said before the graph (a protected line). */
export function AgentWarnings({ entries }: { entries: WorkflowRunDetail['agentMap'] }) {
  return (
    <ul className="bold-run-warnings" aria-label="Agents that changed" data-protected="block">
      {entries.map((entry) => (
        <li key={entry.agentId}>
          <b>{entry.agentId}</b>{' '}
          {entry.status === 'changed'
            ? `was replaced since this run started (it runs with ${entry.incarnation}).`
            : `was removed since this run started (it ran as ${entry.incarnation}).`}
        </li>
      ))}
    </ul>
  )
}

function OrchestrationControls({ id }: { id: string }) {
  const detail = useRun(id).data?.snapshot.orchestration
  const actions = useRunActions(id)
  if (!detail) return null
  return (
    <ClassicPaper tone="plain">
      <RunControls run={detail} actions={actions} />
    </ClassicPaper>
  )
}

function WorkflowControls({ id }: { id: string }) {
  const detail = useWorkflowRun(id).data?.snapshot.run
  const actions = useWorkflowRunActions(id)
  if (!detail) return null
  const changed = detail.agentMap.filter((entry) => entry.status !== 'current')
  return (
    <>
      {changed.length > 0 && <AgentWarnings entries={changed} />}
      <ClassicPaper tone="plain">
        <RunControls run={detail} actions={actions} />
      </ClassicPaper>
    </>
  )
}

/**
 * Pause, Resume and Stop run, and for a recipe run the warning about agents that changed since it started: the old run
 * page's top bar, kept at the top of a run's Graph (the chat's tab and the chat-less run's sheet), so a stuck run can
 * always be stopped (3.29.0).
 */
export function RunControlsBar({ recipe }: { recipe: JobRecipe }) {
  return recipe.kind === 'orchestration' ? (
    <OrchestrationControls id={recipe.ref} />
  ) : (
    <WorkflowControls id={recipe.ref} />
  )
}
