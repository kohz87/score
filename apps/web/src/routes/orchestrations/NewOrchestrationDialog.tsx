import {
  ORCH_ACKNOWLEDGEMENT_TEXT,
  ORCH_DEFAULTS,
  ORCH_LIMITS,
  type AgentSummary,
  type GatePolicy,
  type PreflightCheck,
} from '@score/contract'
import { useEffect, useRef, useState, type FormEvent } from 'react'
import { ApiError } from '../../data/api.ts'
import { describeOrchError, useCreateOrchestration, usePreflight } from './orchestration-queries.ts'
import { AgentChip } from './RunDecisions.tsx'
import './orchestrations.css'

const POLICIES: { id: GatePolicy; label: string }[] = [
  { id: 'every-step', label: 'Ask me before each step' },
  { id: 'lead-asks', label: 'Ask only when the lead asks' },
  { id: 'none', label: 'Never ask' },
]

const checkWord: Record<PreflightCheck['status'], string> = {
  ok: 'OK',
  fail: 'Missing',
  unknown: "Can't be checked",
}

export function PreflightList({
  checks,
}: {
  checks: (Pick<PreflightCheck, 'status' | 'message'> & { id: string })[]
}) {
  return (
    <ul className="orch-checks" aria-label="Preflight checks">
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
  const [lead, setLead] = useState(agents[0]?.id ?? '')
  const [allowed, setAllowed] = useState<string[]>([])
  const [policy, setPolicy] = useState<GatePolicy>('every-step')
  const [budget, setBudget] = useState('')
  const [deadline, setDeadline] = useState('')
  const [maxSteps, setMaxSteps] = useState<number>(ORCH_DEFAULTS.maxSteps)
  const [maxTurns, setMaxTurns] = useState<number>(ORCH_DEFAULTS.maxLeadTurns)
  const [leadEstimate, setLeadEstimate] = useState<number>(ORCH_DEFAULTS.leadTurnEstimateUsd)
  const [stepEstimate, setStepEstimate] = useState<number>(ORCH_DEFAULTS.stepEstimateUsd)
  const [ack, setAck] = useState(false)
  const create = useCreateOrchestration()
  const allowedFor = allowed.filter((id) => id !== lead)
  const preflight = usePreflight(lead, allowedFor)
  useEffect(() => {
    dialog.current?.showModal?.()
  }, [])

  const notes = preflight.data?.gatePolicyNotes
  const blocked = preflight.data ? !preflight.data.ok : false
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
      },
      {
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
            {agents.map((agent) => (
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
          <small className="orch-muted">The lead itself is not on the list.</small>
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

        <section aria-label="Preflight">
          <h3>Before it starts</h3>
          {preflight.isPending && lead !== '' && <p role="status">Checking…</p>}
          {preflight.isError && (
            <p role="alert" className="orch-error">
              Could not run the checks.
            </p>
          )}
          {preflight.data && <PreflightList checks={preflight.data.checks} />}
          <p className="orch-muted">
            Watch shows these runs mixed with the agent&apos;s other work; it is not yet scoped to a
            single run.
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
              create.isPending || !ack || goal.trim() === '' || allowedFor.length === 0 || blocked
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
    if (error.code === 'quota_exhausted') return 'There is not enough storage left for another run.'
    if (error.code === 'fenced')
      return 'Starting work is blocked until you review the reconciliation list on Now.'
  }
  return describeOrchError(error)
}
