import {
  ORCH_ACKNOWLEDGEMENT_TEXT,
  WORKFLOW_LIMITS,
  type AgentSummary,
  type WorkflowGatePolicy,
  type WorkflowPreflight,
} from '@score/contract'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { ApiError } from '../../data/api.ts'
import { describeCreateError, PreflightList } from '../orchestrations/NewOrchestrationDialog.tsx'
import { AgentChip } from '../orchestrations/RunDecisions.tsx'
import {
  useCreateWorkflowRun,
  useWorkflow,
  useWorkflowPreflight,
  useWorkflowVersion,
} from './workflow-queries.ts'
import { ownText } from './workflow-model.ts'
import '../orchestrations/orchestrations.css'
import './workflows.css'

const POLICIES: { id: WorkflowGatePolicy; label: string }[] = [
  { id: 'gates-only', label: 'Ask me only at gates' },
  { id: 'every-step', label: 'Ask me before every agent step, too' },
]

/**
 * Start a workflow run (or run one again): its inputs, limits, the approval policy, the agents it will use with their
 * exact incarnations, the checks, and the same acknowledgement an orchestration needs. No MCP checks: a workflow has no
 * lead and no tools of its own.
 */
export function StartWorkflowDialog({
  workflowId,
  version,
  agents,
  initialInputs,
  rerunOf,
  close,
  created,
}: {
  workflowId: string
  /** Defaults to the latest version. */
  version?: number
  agents: AgentSummary[]
  initialInputs?: Record<string, string>
  rerunOf?: string
  close: () => void
  created: (run: { id: string; briefId: string; roomId: string }) => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const detail = useWorkflow(workflowId)
  const chosen = version ?? detail.data?.latestVersion
  const versionQuery = useWorkflowVersion(workflowId, chosen)
  const preflight = useWorkflowPreflight(workflowId, chosen)
  const create = useCreateWorkflowRun()
  const definition = versionQuery.data?.definition
  const [inputs, setInputs] = useState<Record<string, string>>(initialInputs ?? {})
  const [policy, setPolicy] = useState<WorkflowGatePolicy>('gates-only')
  const [budget, setBudget] = useState('')
  const [deadline, setDeadline] = useState('')
  const [unknownSpend, setUnknownSpend] = useState<'pause' | 'continue'>('pause')
  const [concurrent, setConcurrent] = useState(2)
  const [estimate, setEstimate] = useState(0.5)
  const [ack, setAck] = useState(false)
  useEffect(() => {
    dialog.current?.showModal?.()
  }, [])

  const data: WorkflowPreflight | undefined = preflight.data
  const missing = (definition?.inputs ?? []).filter(
    (input) => input.required && ownText(inputs, input.name).trim() === '',
  )
  const blocked = data ? !data.ok : false
  const failedChecks =
    create.error instanceof ApiError && create.error.code === 'preflight_failed'
      ? (create.error.details as { checks?: WorkflowPreflight['checks'] } | undefined)?.checks
      : undefined

  function submit(event: FormEvent) {
    event.preventDefault()
    if (!data || !definition || chosen === undefined) return
    create.mutate(
      {
        workflowId,
        version: chosen,
        inputs: Object.fromEntries(
          definition.inputs.flatMap((input) => {
            const value = ownText(inputs, input.name).trim()
            return value === '' ? [] : [[input.name, value] as const]
          }),
        ),
        // Exactly the incarnations this screen showed; if one changed meanwhile the server answers 409 conflict.
        agentMap: data.mapping.map(({ agentId, incarnation }) => ({ agentId, incarnation })),
        gatePolicy: policy,
        ...(budget !== '' && Number(budget) > 0 ? { budgetUsd: Number(budget) } : {}),
        ...(deadline !== '' ? { deadlineAt: new Date(deadline).toISOString() } : {}),
        unknownSpend,
        maxConcurrentSteps: concurrent,
        stepEstimateUsd: estimate,
        ...(rerunOf ? { rerunOf } : {}),
        acknowledgement: { text: ORCH_ACKNOWLEDGEMENT_TEXT },
      },
      {
        onSuccess: ({ run }) => created({ id: run.id, briefId: run.briefId, roomId: run.roomId }),
        onError: () => void preflight.refetch(),
      },
    )
  }

  return (
    <dialog
      ref={dialog}
      open={typeof HTMLDialogElement.prototype.showModal !== 'function'}
      className="orch-dialog"
      aria-labelledby="wf-start-title"
      onCancel={(event) => {
        event.preventDefault()
        close()
      }}
    >
      <div className="orch-dialog-head">
        <h2 id="wf-start-title">
          {rerunOf ? 'Run again' : 'Start'} {definition?.name ?? 'workflow'}
        </h2>
        <button type="button" onClick={close}>
          Close
        </button>
      </div>
      {chosen !== undefined && (
        <p className="orch-muted">
          Version {chosen}.{' '}
          {rerunOf
            ? 'A new run of the same version, with the inputs of the earlier run. Change them if you like.'
            : 'The agents work through the steps you drew; Score checks every step it starts.'}
        </p>
      )}
      {(detail.isError || versionQuery.isError) && (
        <p role="alert" className="orch-error">
          Couldn’t load this workflow.
        </p>
      )}
      <form onSubmit={submit} className="orch-form">
        {definition && definition.inputs.length > 0 && (
          <fieldset className="orch-field wf-fieldset">
            <legend>Inputs</legend>
            {definition.inputs.map((input) => (
              <label key={input.name} className="orch-field">
                <span>
                  {input.label}
                  {input.required ? '' : ' (optional)'}
                </span>
                <textarea
                  rows={input.maxChars > 200 ? 3 : 1}
                  value={ownText(inputs, input.name)}
                  maxLength={input.maxChars}
                  required={input.required}
                  onChange={(event) =>
                    setInputs((current) => ({ ...current, [input.name]: event.target.value }))
                  }
                />
                <small className="orch-muted">
                  {ownText(inputs, input.name).length} of {input.maxChars} characters
                </small>
              </label>
            ))}
          </fieldset>
        )}

        <fieldset className="orch-field">
          <legend>Approvals</legend>
          {POLICIES.map((item) => (
            <label key={item.id} className="orch-check orch-policy">
              <input
                type="radio"
                name="wf-policy"
                checked={policy === item.id}
                onChange={() => setPolicy(item.id)}
              />
              <span>
                <strong>{item.label}</strong>
                {data && <small>{data.gatePolicyNotes[item.id]}</small>}
              </span>
            </label>
          ))}
        </fieldset>

        <div className="orch-row">
          <label className="orch-field">
            <span>Budget in USD (optional)</span>
            <input
              inputMode="decimal"
              value={budget}
              onChange={(event) => setBudget(event.target.value)}
            />
          </label>
          <label className="orch-field">
            <span>Deadline (optional)</span>
            <input
              type="datetime-local"
              value={deadline}
              onChange={(event) => setDeadline(event.target.value)}
            />
          </label>
        </div>

        <fieldset className="orch-field">
          <legend>When Hermes doesn’t say what a step cost</legend>
          <label className="orch-check">
            <input
              type="radio"
              name="wf-unknown"
              checked={unknownSpend === 'pause'}
              onChange={() => setUnknownSpend('pause')}
            />
            <span>
              <strong>Pause the run and ask me</strong>
              <small className="orch-muted"> (when a budget is set)</small>
            </span>
          </label>
          <label className="orch-check">
            <input
              type="radio"
              name="wf-unknown"
              checked={unknownSpend === 'continue'}
              onChange={() => setUnknownSpend('continue')}
            />
            <span>
              <strong>Keep going</strong>
              <small className="orch-muted"> (unknown spend is never counted as zero)</small>
            </span>
          </label>
          {data && <small className="orch-muted">{data.spendNote}</small>}
        </fieldset>

        <details>
          <summary>Limits and estimates</summary>
          <div className="orch-row">
            <label className="orch-field">
              <span>Steps at the same time (1 to 3)</span>
              <input
                type="number"
                min={1}
                max={3}
                value={concurrent}
                onChange={(event) => setConcurrent(Number(event.target.value))}
              />
            </label>
            <label className="orch-field">
              <span>Estimate per step (USD)</span>
              <input
                type="number"
                min={0.01}
                step={0.01}
                value={estimate}
                onChange={(event) => setEstimate(Number(event.target.value))}
              />
            </label>
          </div>
          <p className="orch-muted">
            At most {(data?.maxSteps ?? definition) ? (data?.maxSteps ?? '…') : '…'} steps can run,
            counting retries (the limit is {WORKFLOW_LIMITS.maxSteps}). Score reserves the estimate
            against the budget before a step starts.
          </p>
        </details>

        <section aria-label="Agents this run will use">
          <h3>Agents this run will use</h3>
          {data ? (
            <ul className="wf-agents" aria-label="Agent mapping">
              {data.mapping.map((entry) => (
                <li key={entry.agentId}>
                  <AgentChip agentId={entry.agentId} agents={agents} />{' '}
                  <span className="orch-mono" title="Identifies the exact version of the agent">
                    {entry.incarnation}
                  </span>
                </li>
              ))}
            </ul>
          ) : (
            <p className="orch-muted" role="status">
              Reading the agents…
            </p>
          )}
          <p className="orch-muted">
            The run keeps using exactly these agents. If one is replaced later, its steps wait until
            you decide.
          </p>
        </section>

        <section aria-label="Before it starts">
          <h3>Before it starts</h3>
          {preflight.isPending && chosen !== undefined && <p role="status">Checking…</p>}
          {preflight.isError && (
            <p role="alert" className="orch-error">
              Couldn’t run the checks.
            </p>
          )}
          {data && <PreflightList checks={data.checks} />}
          <p className="orch-muted">
            Watch also shows the agent’s other work; it can’t show a single run on its own.
          </p>
        </section>

        <label className="orch-check orch-ack">
          <input type="checkbox" checked={ack} onChange={(event) => setAck(event.target.checked)} />
          <span>{ORCH_ACKNOWLEDGEMENT_TEXT}</span>
        </label>

        {create.isError && (
          <div role="alert" className="orch-error">
            <p>{describeStartError(create.error)}</p>
            {failedChecks && <PreflightList checks={failedChecks} />}
          </div>
        )}
        <div className="orch-actions">
          <button
            type="submit"
            className="orch-primary"
            disabled={
              create.isPending || !ack || !data || !definition || blocked || missing.length > 0
            }
          >
            {create.isPending ? 'Starting…' : 'Start the run'}
          </button>
          {missing.length > 0 && (
            <span className="orch-muted">
              Fill in {missing.map((input) => input.label).join(', ')} first.
            </span>
          )}
          {blocked && <span className="orch-muted">Fix the missing items above first.</span>}
        </div>
      </form>
    </dialog>
  )
}

function describeStartError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'conflict')
      return 'An agent changed while this screen was open. The list above now shows the current ones. Check it and start again.'
    if (error.code === 'invalid_inputs') return error.message
  }
  return describeCreateError(error)
}
