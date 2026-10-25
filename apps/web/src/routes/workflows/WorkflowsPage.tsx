import type { WorkflowSummary } from '@score/contract'
import { useMemo, useState } from 'react'
import { Link, useNavigate } from '../../shell/framed-paths.tsx'
import { AgentGlyph } from '../../components/AgentGlyph.tsx'
import { ApiError } from '../../data/api.ts'
import { useStreamQuery } from '../../data/query-client.ts'
import { statusLabel } from '../orchestrations/orch-model.ts'
import { taskAgentsQuery } from '../../data/task-queries.ts'
import { ExportDialog } from './ExportDialog.tsx'
import { StartWorkflowDialog } from './StartWorkflowDialog.tsx'
import {
  useDeleteWorkflow,
  useSaveWorkflow,
  useWorkflows,
  workflowRunsQuery,
} from './workflow-queries.ts'
import { graphOutcomeLabel } from './workflow-run-model.ts'
import { apiFetch } from '../../data/api.ts'
import { WorkflowDetailSchema } from '@score/contract'
import '../orchestrations/orchestrations.css'
import './workflows.css'

const when = (iso: string) =>
  new Date(iso).toLocaleDateString([], { day: 'numeric', month: 'short', year: 'numeric' })

/** Flow › Workflows: the saved workflows, with what each is for, whether runs used it, and how its last run ended. */
export function WorkflowsPage() {
  const list = useWorkflows()
  const runs = useStreamQuery(workflowRunsQuery).data
  const agents = useStreamQuery(taskAgentsQuery).data ?? []
  const navigate = useNavigate()
  const remove = useDeleteWorkflow()
  const save = useSaveWorkflow()
  const [starting, setStarting] = useState<WorkflowSummary | null>(null)
  const [exporting, setExporting] = useState<WorkflowSummary | null>(null)
  const [deleting, setDeleting] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const lastRun = useMemo(() => {
    const byWorkflow = new Map<string, NonNullable<typeof runs>[number]>()
    for (const run of runs ?? [])
      if (!byWorkflow.has(run.workflowId)) byWorkflow.set(run.workflowId, run)
    return byWorkflow
  }, [runs])
  const byAgent = new Map(agents.map((agent) => [agent.id, agent]))

  async function duplicate(workflow: WorkflowSummary) {
    setNotice(null)
    try {
      const detail = WorkflowDetailSchema.parse(
        await apiFetch(`workflows/${encodeURIComponent(workflow.id)}`),
      )
      const definition = {
        ...detail.latest.definition,
        name: `${detail.latest.definition.name} (copy)`.slice(0, 120),
      }
      const created = await save.mutateAsync({ workflowId: null, definition })
      void navigate(`/workflows/${encodeURIComponent(created.workflowId)}`)
    } catch (error) {
      setNotice(
        error instanceof ApiError && error.code === 'quota_exhausted'
          ? 'There are already as many workflows as Score keeps. Delete one you don’t use first.'
          : 'Couldn’t duplicate that workflow. Try again.',
      )
    }
  }

  return (
    <div className="wf-page">
      <section className="wf-page__head" aria-label="Workflows">
        <div>
          <h2>Workflows</h2>
          <p className="orch-muted">
            A workflow is a fixed route of agent steps, gates that wait for you, branches and joins.
            Draw it once, then start runs of it.
          </p>
        </div>
        <Link to="/workflows/new" className="wf-button wf-button--primary">
          New workflow
        </Link>
      </section>

      {notice && (
        <p role="alert" className="orch-error">
          {notice}
        </p>
      )}
      {list.isPending && <p role="status">Loading workflows…</p>}
      {list.isError && (
        <p role="alert" className="orch-error">
          Couldn’t load workflows.{' '}
          <button type="button" onClick={() => void list.refetch()}>
            Try again
          </button>
        </p>
      )}
      {list.data && list.data.items.length === 0 && (
        <p className="wf-empty">
          No workflows yet. Start with <Link to="/workflows/new">a new one</Link>: add an agent
          step, a gate for your approval and an end.
        </p>
      )}
      {list.data && list.data.items.length > 0 && (
        <ul className="wf-list" aria-label="Saved workflows">
          {list.data.items.map((workflow) => {
            const last = lastRun.get(workflow.id)
            return (
              <li key={workflow.id} className="wf-card" aria-label={workflow.name}>
                <div className="wf-card__main">
                  <h3>
                    <Link to={`/workflows/${encodeURIComponent(workflow.id)}`}>
                      {workflow.name}
                    </Link>
                  </h3>
                  {workflow.description && <p className="orch-muted">{workflow.description}</p>}
                  <p className="wf-card__facts">
                    <span>Version {workflow.latestVersion}</span>
                    <span className={`wf-chip${workflow.used ? ' wf-chip--used' : ''}`}>
                      {workflow.used ? 'Used by runs' : 'Not used yet'}
                    </span>
                    <span className="orch-muted">Updated {when(workflow.updatedAt)}</span>
                    {workflow.activeRuns > 0 && (
                      <span className="wf-chip wf-chip--live">
                        {workflow.activeRuns} {workflow.activeRuns === 1 ? 'run' : 'runs'} going
                      </span>
                    )}
                  </p>
                  <p className="wf-card__agents" aria-label="Agents">
                    {workflow.agentIds.map((id) => {
                      const agent = byAgent.get(id)
                      return agent ? (
                        <span key={id} className="orch-agent">
                          <AgentGlyph agent={agent} size="xs" describeShape />
                          <span>{agent.name}</span>
                        </span>
                      ) : (
                        <span key={id} className="orch-agent">
                          {id}
                        </span>
                      )
                    })}
                  </p>
                  <p className="wf-card__last">
                    {last ? (
                      <>
                        Last run:{' '}
                        <Link to={`/runs/${encodeURIComponent(last.briefId)}`}>
                          {statusLabel[last.status]}
                        </Link>
                        {last.graphOutcome
                          ? `, ${graphOutcomeLabel[last.graphOutcome].toLowerCase()}`
                          : ''}
                      </>
                    ) : (
                      <span className="orch-muted">No runs yet</span>
                    )}
                  </p>
                </div>
                <div className="wf-card__actions">
                  <button
                    type="button"
                    className="orch-primary"
                    onClick={() => setStarting(workflow)}
                  >
                    Run
                    <span className="wf-visually-hidden"> {workflow.name}</span>
                  </button>
                  <Link className="wf-button" to={`/workflows/${encodeURIComponent(workflow.id)}`}>
                    Edit<span className="wf-visually-hidden"> {workflow.name}</span>
                  </Link>
                  <button type="button" onClick={() => void duplicate(workflow)}>
                    Duplicate<span className="wf-visually-hidden"> {workflow.name}</span>
                  </button>
                  <button type="button" onClick={() => setExporting(workflow)}>
                    Export<span className="wf-visually-hidden"> {workflow.name}</span>
                  </button>
                  {deleting === workflow.id ? (
                    <span className="wf-confirm">
                      <span>Delete this workflow for good?</span>
                      <button
                        type="button"
                        className="orch-danger"
                        disabled={remove.isPending}
                        onClick={() =>
                          remove.mutate(workflow.id, {
                            onSuccess: () => setDeleting(null),
                            onError: (error) => {
                              setDeleting(null)
                              setNotice(
                                error instanceof ApiError && error.code === 'workflow_used'
                                  ? 'A run has used this workflow, so it stays. Runs keep their own copy of what they ran.'
                                  : 'Couldn’t delete that workflow. Try again.',
                              )
                            },
                          })
                        }
                      >
                        Delete {workflow.name}
                      </button>
                      <button type="button" onClick={() => setDeleting(null)}>
                        Keep it
                      </button>
                    </span>
                  ) : (
                    <button
                      type="button"
                      disabled={workflow.used}
                      title={
                        workflow.used
                          ? 'Runs have used this workflow, so it can’t be deleted'
                          : undefined
                      }
                      onClick={() => setDeleting(workflow.id)}
                    >
                      Delete<span className="wf-visually-hidden"> {workflow.name}</span>
                    </button>
                  )}
                </div>
              </li>
            )
          })}
        </ul>
      )}
      {list.data && (
        <p className="orch-muted wf-inventory">
          {list.data.inventory.definitions} of {list.data.inventory.maxDefinitions} workflows,{' '}
          {list.data.inventory.versions} saved versions (up to{' '}
          {list.data.inventory.maxVersionsPerDefinition} each).
        </p>
      )}

      {starting && (
        <StartWorkflowDialog
          workflowId={starting.id}
          agents={agents}
          close={() => setStarting(null)}
          created={(run) => {
            setStarting(null)
            void navigate(`/runs/${encodeURIComponent(run.briefId)}`)
          }}
        />
      )}
      {exporting && (
        <ExportDialog
          workflowId={exporting.id}
          version={exporting.latestVersion}
          name={exporting.name}
          close={() => setExporting(null)}
        />
      )}
    </div>
  )
}
