import {
  ORCH_ACKNOWLEDGEMENT_TEXT,
  ORCH_DEFAULTS,
  ORCH_LIMITS,
  type AgentSummary,
  type CodingWorkerPreflight,
  type CostSource,
  type GatePolicy,
  type PreflightCheck,
} from '@score/contract'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { ApiError } from '../../data/api.ts'
import { readinessText } from './orch-model.ts'
import { describeOrchError, useCreateOrchestration, usePreflight } from './orchestration-queries.ts'
import { AgentChip } from './RunDecisions.tsx'
import './orchestrations.css'

const POLICIES: { id: GatePolicy; label: string }[] = [
  { id: 'every-step', label: 'Ask me before each step' },
  { id: 'lead-asks', label: 'Ask only when the lead asks' },
  { id: 'none', label: 'Never ask' },
]

const checkWord: Record<PreflightCheck['status'], string> = {
  ok: 'Ready',
  fail: 'Missing',
  unknown: 'Can’t be checked',
}

const costSourceName: Record<CostSource, string> = {
  hermes: 'Hermes agents',
  'claude-code': 'Claude Code',
  codex: 'Codex',
}

/**
 * The coding agents of a run and what each can read, in plain words. A reach beyond the workspace needs one
 * acknowledgement for the whole list; `accepted` says whether it covers the policies shown right now.
 */
export function CodingWorkers({
  workers,
  agents,
  accepted,
  onAccept,
  answerGoesTo = 'handed back to the lead, which uses an online model',
}: {
  workers: CodingWorkerPreflight[]
  agents: AgentSummary[]
  accepted: boolean
  onAccept: (accepted: boolean) => void
  /** Where the answer goes after the run keeps it (an orchestration hands it to its lead; a workflow to later steps). */
  answerGoesTo?: string
}) {
  const wide = workers.some((worker) => worker.reachBeyondWorkspace)
  return (
    <section aria-label="Coding agents in this run" className="orch-workers">
      <h3>Coding agents in this run</h3>
      <p className="orch-muted">
        Claude Code and Codex work on this computer, in the workspace you gave them. This is what
        each one can read and do in this run.
      </p>
      <ul>
        {workers.map((worker) => (
          <li key={worker.agentId} data-ready={worker.readiness === 'ready'}>
            <AgentChip agentId={worker.agentId} agents={agents} />
            {worker.readiness === 'ready' && worker.reach ? (
              <p>{worker.reach}</p>
            ) : (
              <p className="orch-error">{worker.detail ?? readinessText[worker.readiness]}</p>
            )}
          </li>
        ))}
      </ul>
      {wide && (
        <div className="orch-risk">
          <p>
            <strong>What to know first.</strong> Whatever a coding agent can read, it can repeat in
            its answer. That answer is shown in the run, kept in Score and {answerGoesTo}. If those
            files hold anything private, such as keys or passwords, pick another agent or don’t
            start this run.
          </p>
          <label className="orch-check orch-ack">
            <input
              type="checkbox"
              checked={accepted}
              onChange={(event) => onAccept(event.target.checked)}
            />
            <span>
              I understand what these coding agents can read, and I accept it for this run.
            </span>
          </label>
        </div>
      )}
    </section>
  )
}

export function PreflightList({
  checks,
}: {
  checks: (Pick<PreflightCheck, 'status' | 'message'> & { id: string })[]
}) {
  return (
    <ul className="orch-checks" aria-label="Checks before starting">
      {checks.map((check) => (
        <li key={check.id} className={`orch-check-item orch-check-item--${check.status}`}>
          <strong>{checkWord[check.status]}</strong>
          <span>{check.message}</span>
        </li>
      ))}
    </ul>
  )
}

/** Start a run: goal, lead, allowed agents, limits, gate policy, the acknowledgement and the preflight result. */
export function NewOrchestrationDialog({
  agents,
  close,
  created,
}: {
  agents: AgentSummary[]
  close: () => void
  created: (run: { id: string; briefId: string; roomId: string }) => void
}) {
  const dialog = useRef<HTMLDialogElement>(null)
  const [goal, setGoal] = useState('')
  const leads = agents.filter((agent) => !agent.runtime || agent.runtime === 'hermes')
  const [lead, setLead] = useState(leads[0]?.id ?? '')
  const [allowed, setAllowed] = useState<string[]>([])
  const [policy, setPolicy] = useState<GatePolicy>('every-step')
  const [budget, setBudget] = useState('')
  const [deadline, setDeadline] = useState('')
  const [maxSteps, setMaxSteps] = useState<number>(ORCH_DEFAULTS.maxSteps)
  const [maxTurns, setMaxTurns] = useState<number>(ORCH_DEFAULTS.maxLeadTurns)
  const [leadEstimate, setLeadEstimate] = useState<number>(ORCH_DEFAULTS.leadTurnEstimateUsd)
  const [stepEstimate, setStepEstimate] = useState<number>(ORCH_DEFAULTS.stepEstimateUsd)
  const [ack, setAck] = useState(false)
  const [codingSteps, setCodingSteps] = useState<number>(ORCH_DEFAULTS.codingSteps)
  const [unknownCost, setUnknownCost] = useState<CostSource[]>([])
  // The policy ids the person accepted the reach of. A changed id is not covered: it has to be accepted again.
  const [reachAccepted, setReachAccepted] = useState<string[]>([])
  const create = useCreateOrchestration()
  const allowedFor = allowed.filter((id) => id !== lead)
  const preflight = usePreflight(lead, allowedFor)
  useEffect(() => {
    dialog.current?.showModal?.()
  }, [])

  const workers = preflight.data?.workers ?? []
  const reachIds = workers.flatMap((worker) =>
    worker.reachBeyondWorkspace && worker.policyId ? [worker.policyId] : [],
  )
  const reachCovered = reachIds.every((id) => reachAccepted.includes(id))
  const costSources: CostSource[] = ['hermes', ...new Set(workers.map((worker) => worker.runtime))]
  const notes = preflight.data?.gatePolicyNotes
  // A refused check (a coding agent this computer can't run, say) blocks the start just like a failed one.
  const blocked = preflight.data ? !preflight.data.ok : preflight.isError
  const failed =
    create.error instanceof ApiError && create.error.code === 'preflight_failed'
      ? (create.error.details as { checks?: PreflightCheck[] } | undefined)?.checks
      : undefined

  function submit(event: FormEvent) {
    event.preventDefault()
    create.mutate(
      {
        goal: goal.trim(),
        leadAgentId: lead,
        allowedAgents: allowedFor,
        gatePolicy: policy,
        ...(budget !== '' && Number(budget) > 0 ? { budgetUsd: Number(budget) } : {}),
        ...(deadline !== '' ? { deadlineAt: new Date(deadline).toISOString() } : {}),
        maxSteps,
        maxLeadTurns: maxTurns,
        maxConcurrentSteps: ORCH_DEFAULTS.maxConcurrentSteps,
        leadTurnEstimateUsd: leadEstimate,
        stepEstimateUsd: stepEstimate,
        acknowledgement: { text: ORCH_ACKNOWLEDGEMENT_TEXT },
        ...(workers.length > 0
          ? {
              codingPolicies: Object.fromEntries(
                workers.flatMap((worker) =>
                  worker.policyId ? [[worker.agentId, worker.policyId] as const] : [],
                ),
              ),
              codingSteps,
              ...(reachIds.length > 0 ? { acknowledgeCodingReach: { policyIds: reachIds } } : {}),
              ...(unknownCost.length > 0 ? { acceptUnknownCost: unknownCost } : {}),
            }
          : {}),
      },
      {
        // The policy a worker was approved with moved on: look again before the person decides.
        onError: (error) => {
          if (error instanceof ApiError && error.code === 'policy_changed') void preflight.refetch()
        },
        onSuccess: ({ orchestration }) =>
          created({
            id: orchestration.id,
            briefId: orchestration.briefId,
            roomId: orchestration.roomId,
          }),
      },
    )
  }

  return (
    <dialog
      ref={dialog}
      open={typeof HTMLDialogElement.prototype.showModal !== 'function'}
      className="orch-dialog"
      aria-labelledby="orch-new-title"
      onCancel={(event) => {
        event.preventDefault()
        close()
      }}
    >
      <div className="orch-dialog-head">
        <h2 id="orch-new-title">New orchestration</h2>
        <button type="button" onClick={close}>
          Close
        </button>
      </div>
      <p className="orch-muted">
        A lead agent decides the steps while it works, hands them to team agents and asks you when
        it needs to. Score checks every request the lead makes.
      </p>
      <form onSubmit={submit} className="orch-form">
        <label className="orch-field">
          <span>Goal</span>
          <textarea
            required
            rows={4}
            value={goal}
            maxLength={ORCH_LIMITS.goalBytes}
            onChange={(event) => setGoal(event.target.value)}
          />
        </label>
        <label className="orch-field">
          <span>Lead</span>
          <select value={lead} onChange={(event) => setLead(event.target.value)}>
            {leads.map((agent) => (
              <option key={agent.id} value={agent.id}>
                {agent.name}
              </option>
            ))}
          </select>
        </label>
        <fieldset className="orch-field">
          <legend>Agents the lead may hand work to (up to {ORCH_LIMITS.maxAllowedAgents})</legend>
          <div className="orch-agent-pick">
            {agents
              .filter((agent) => agent.id !== lead)
              .map((agent) => (
                <label key={agent.id} className="orch-check">
                  <input
                    type="checkbox"
                    disabled={agent.runtime === 'antigravity' || agent.runtime === 'opencode'}
                    checked={allowed.includes(agent.id)}
                    onChange={(event) =>
                      setAllowed((list) =>
                        event.target.checked
                          ? [...list, agent.id]
                          : list.filter((id) => id !== agent.id),
                      )
                    }
                  />
                  <AgentChip agentId={agent.id} agents={agents} />
                </label>
              ))}
          </div>
          <small className="orch-muted">
            The lead itself isn’t on the list. Only Hermes agents can lead. Claude Code and Codex
            agents can take steps.
          </small>
        </fieldset>
        <fieldset className="orch-field">
          <legend>Approvals</legend>
          {POLICIES.map((item) => (
            <label key={item.id} className="orch-check orch-policy">
              <input
                type="radio"
                name="orch-policy"
                checked={policy === item.id}
                onChange={() => setPolicy(item.id)}
              />
              <span>
                <strong>{item.label}</strong>
                {notes && <small>{notes[item.id]}</small>}
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
        <details>
          <summary>Limits and estimates</summary>
          <p className="orch-muted">
            Estimates are per lead turn and per step. Score reserves them against the budget before
            work starts and replaces them with the real spend afterwards.
          </p>
          <div className="orch-row">
            <label className="orch-field">
              <span>Most steps</span>
              <input
                type="number"
                min={1}
                max={ORCH_LIMITS.maxSteps}
                value={maxSteps}
                onChange={(event) => setMaxSteps(Number(event.target.value))}
              />
            </label>
            <label className="orch-field">
              <span>Most lead turns</span>
              <input
                type="number"
                min={1}
                max={ORCH_LIMITS.maxLeadTurns}
                value={maxTurns}
                onChange={(event) => setMaxTurns(Number(event.target.value))}
              />
            </label>
            <label className="orch-field">
              <span>Estimate per lead turn (USD)</span>
              <input
                type="number"
                min={0.01}
                step={0.01}
                value={leadEstimate}
                onChange={(event) => setLeadEstimate(Number(event.target.value))}
              />
            </label>
            {workers.length > 0 && (
              <label className="orch-field">
                <span>Most coding steps</span>
                <input
                  type="number"
                  min={1}
                  max={ORCH_LIMITS.maxCodingSteps}
                  value={codingSteps}
                  onChange={(event) => setCodingSteps(Number(event.target.value))}
                />
              </label>
            )}
            <label className="orch-field">
              <span>Estimate per step (USD)</span>
              <input
                type="number"
                min={0.01}
                step={0.01}
                value={stepEstimate}
                onChange={(event) => setStepEstimate(Number(event.target.value))}
              />
            </label>
          </div>
        </details>

        <section aria-label="Before it starts">
          <h3>Before it starts</h3>
          {preflight.isPending && lead !== '' && <p role="status">Checking…</p>}
          {preflight.isError && (
            <p role="alert" className="orch-error">
              {preflight.error instanceof ApiError
                ? describeCreateError(preflight.error)
                : 'Couldn’t run the checks.'}
            </p>
          )}
          {preflight.data && <PreflightList checks={preflight.data.checks} />}
          {workers.length > 0 && (
            <CodingWorkers
              workers={workers}
              agents={agents}
              accepted={reachIds.length > 0 && reachCovered}
              onAccept={(accepted) => setReachAccepted(accepted ? reachIds : [])}
            />
          )}
          {workers.length > 0 && (
            <fieldset className="orch-field">
              <legend>If the cost of some work can’t be worked out</legend>
              <small className="orch-muted">
                This only matters when you set a budget. Without it, the run goes on either way.
              </small>
              {costSources.map((source) => (
                <label key={source} className="orch-check">
                  <input
                    type="checkbox"
                    checked={unknownCost.includes(source)}
                    onChange={(event) =>
                      setUnknownCost((list) =>
                        event.target.checked
                          ? [...list, source]
                          : list.filter((item) => item !== source),
                      )
                    }
                  />
                  <span>Keep going when the cost of {costSourceName[source]} is unknown</span>
                </label>
              ))}
            </fieldset>
          )}
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
            <p>{describeCreateError(create.error)}</p>
            {failed && <PreflightList checks={failed} />}
          </div>
        )}
        <div className="orch-actions">
          <button
            type="submit"
            className="orch-primary"
            disabled={
              create.isPending ||
              !ack ||
              goal.trim() === '' ||
              allowedFor.length === 0 ||
              blocked ||
              !reachCovered
            }
          >
            {create.isPending ? 'Starting…' : 'Start orchestration'}
          </button>
          {blocked && <span className="orch-muted">Fix the missing items above first.</span>}
        </div>
      </form>
    </dialog>
  )
}

export function describeCreateError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'preflight_failed') return 'Something it needs is missing:'
    if (error.code === 'capacity')
      return 'Score is already running as many orchestrations or steps as it allows. Try again when one has finished.'
    if (error.code === 'quota_exhausted') return 'There isn’t enough storage left for another run.'
    if (error.code === 'fenced') return 'Starting work is blocked until you review the list on Now.'
    if (error.code === 'policy_changed')
      return 'A coding agent changed since you looked. Check what it can read below, then start again.'
    if (error.code === 'reach_not_acknowledged')
      return 'Accept what the coding agents can read before you start.'
    if (error.code === 'coding_workers_need_units')
      return 'Coding agents can take steps only where Score runs them as system services, and this computer isn’t set up for that.'
  }
  return describeOrchError(error)
}
