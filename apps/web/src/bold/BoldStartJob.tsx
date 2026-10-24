import {
  JobSchema,
  ORCH_ACKNOWLEDGEMENT_TEXT,
  ORCH_DEFAULTS,
  OrchestrationCreatedSchema,
  RoutineSummarySchema,
  TeamRoomResponseSchema,
  TriggerCreatedSchema,
  WorkflowRunCreatedSchema,
  WorkflowVersionSchema,
  type AgentSummary,
  type OrchestrationCreate,
  type WorkflowRunCreate,
} from '@score/contract'
import { useQueries, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  createContext,
  useContext,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { AgentGlyph } from '../components/AgentGlyph.tsx'
import { apiFetch, ApiError } from '../data/api.ts'
import { copyText } from '../data/clipboard.ts'
import { useStreamQuery } from '../data/query-client.ts'
import { agentsQuery } from '../routes/chat/queries.ts'
import { describeCreateError } from '../routes/orchestrations/NewOrchestrationDialog.tsx'
import { post, usePreflight } from '../routes/orchestrations/orchestration-queries.ts'
import { fetchRoutines, routinesKey } from '../routes/team/routine-queries.ts'
import {
  useWorkflow,
  useWorkflowPreflight,
  useWorkflows,
} from '../routes/workflows/workflow-queries.ts'
import { CloseIcon } from './BoldIcons.tsx'
import {
  deadlineIso,
  oneStepRecipe,
  orchestrationPolicy,
  orchestrationTitleOf,
  SCHEDULES,
  titleOf,
  triggerNameOf,
  triggerRequest,
  workflowPolicy,
  type Ask,
  type StartCheck,
  type When,
} from './bold-start-job.ts'
import './bold-start.css'

type RecipeChoice =
  { kind: 'lead' } | { kind: 'none' } | { kind: 'workflow'; id: string; name: string }

type Result =
  | { kind: 'job'; title: string; jobId: string; orchestrationId?: string }
  | { kind: 'workflow'; title: string; runId: string }
  | { kind: 'routine'; title: string; schedule: string }
  | { kind: 'trigger'; title: string; url: string | null; secret: string }

const NO_AGENTS: AgentSummary[] = []

export const StartJobContext = createContext<{ openStartJob: () => void } | null>(null)

export function useStartJob() {
  return useContext(StartJobContext)
}

function checkOf(query: { isPending: boolean; isError: boolean }): StartCheck {
  if (query.isPending)
    return { key: 'team-room', status: 'pending', text: 'Checking the team room' }
  if (query.isError)
    return { key: 'team-room', status: 'fail', text: 'The team room could not be read' }
  return { key: 'team-room', status: 'ok', text: 'The team room is ready' }
}

function checksFromPreflight(
  pending: boolean,
  failed: boolean,
  checks: { id: string; status: 'ok' | 'fail' | 'unknown'; message: string }[] | undefined,
): StartCheck[] {
  if (pending)
    return [{ key: 'preflight', status: 'pending', text: 'Checking Hermes and the team' }]
  if (failed || !checks)
    return [{ key: 'preflight', status: 'fail', text: 'The checks could not be read' }]
  return checks.map((check) => ({
    key: check.id,
    status: check.status === 'ok' ? 'ok' : 'fail',
    text: check.status === 'unknown' ? `${check.message} (could not be checked)` : check.message,
  }))
}

function Dot({ status }: { status: StartCheck['status'] }) {
  return (
    <span
      className={`dot start-dot start-dot--${status}`}
      style={{
        background:
          status === 'ok' ? 'var(--ok)' : status === 'fail' ? 'var(--bad)' : 'var(--warn)',
      }}
      aria-hidden="true"
    />
  )
}

function Checklist({ checks, children }: { checks: StartCheck[]; children?: ReactNode }) {
  return (
    <section className="inner start-checks" aria-label="Before it starts" data-protected="block">
      <span className="lab">Before it starts</span>
      <ul>
        {checks.map((check) => (
          <li key={check.key} className="row small">
            <Dot status={check.status} />
            <span className="grow">{check.text}</span>
            <span className="sr">
              {check.status === 'ok'
                ? 'Passed'
                : check.status === 'fail'
                  ? 'Blocks starting'
                  : 'Checking'}
            </span>
          </li>
        ))}
      </ul>
      {children}
    </section>
  )
}

function AgentPick({
  agents,
  leadId,
  chosen,
  onChange,
}: {
  agents: AgentSummary[]
  leadId: string
  chosen: string[]
  onChange: (next: string[]) => void
}) {
  const options = agents.filter((agent) => agent.id !== leadId)
  return (
    <fieldset className="bold-agent-pick" data-protected="flex">
      <legend className="lab">Agents allowed</legend>
      <p className="small muted start-pick-note">
        lead plans the work. Only these agents may take a step.
      </p>
      <div className="row wrap start-pick">
        {options.map((agent) => {
          const checked = chosen.includes(agent.id)
          return (
            <label key={agent.id} className="chip start-agent-chip">
              <input
                type="checkbox"
                checked={checked}
                onChange={() =>
                  onChange(checked ? chosen.filter((id) => id !== agent.id) : [...chosen, agent.id])
                }
              />
              <AgentGlyph agent={agent} size="sm" plain bare decorative />
              <span>{agent.name}</span>
            </label>
          )
        })}
      </div>
    </fieldset>
  )
}

/** The Start a job dialog (PLAN 11.10c), rebuilt from the prototype's mStart and the trigger wizard. */
export function BoldStartJob({ onClose }: { onClose: () => void }) {
  const dialog = useRef<HTMLDivElement>(null)
  const closeButton = useRef<HTMLButtonElement>(null)
  const titleId = useId()
  const queryClient = useQueryClient()
  const agents = useStreamQuery(agentsQuery).data ?? NO_AGENTS
  const workflows = useWorkflows()
  const teamRoom = useQuery({
    queryKey: ['bold', 'team-room'],
    queryFn: async ({ signal }) =>
      TeamRoomResponseSchema.parse(await apiFetch('team-room', { signal })),
    retry: false,
  })

  const [what, setWhat] = useState('')
  const [recipe, setRecipe] = useState<RecipeChoice>({ kind: 'lead' })
  const [when, setWhen] = useState<When>('once')
  const [ask, setAsk] = useState<Ask>('risky')
  const [turns, setTurns] = useState(8)
  const [cap, setCap] = useState(5)
  const [deadline, setDeadline] = useState('18:00')
  const [schedule, setSchedule] = useState<string>(SCHEDULES[0])
  const [triggerApp, setTriggerApp] = useState('Another app')
  const [triggerName, setTriggerName] = useState('')
  const [ack, setAck] = useState(false)
  const [reachAccepted, setReachAccepted] = useState(false)
  const [saveRecipe, setSaveRecipe] = useState(false)
  const [inputs, setInputs] = useState<Record<string, string>>({})
  const [allowed, setAllowed] = useState<string[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<Result | null>(null)

  const hermesAgents = agents.filter((agent) => !agent.runtime || agent.runtime === 'hermes')
  const teamLead = teamRoom.data?.room.leadAgentId ?? null
  const leadId =
    (teamLead && hermesAgents.some((agent) => agent.id === teamLead)
      ? teamLead
      : hermesAgents[0]?.id) ?? ''
  const defaultAllowed = useMemo(
    () => agents.filter((agent) => agent.id !== leadId).map((agent) => agent.id),
    [agents, leadId],
  )
  const allowedFor = allowed ?? defaultAllowed
  const leadAgent = agents.find((agent) => agent.id === leadId)

  const selectedWorkflowId = recipe.kind === 'workflow' ? recipe.id : undefined
  const workflow = useWorkflow(selectedWorkflowId)
  const workflowDefinition = workflow.data?.latest.definition
  const workflowVersion = workflow.data?.latestVersion
  const workflowPreflight = useWorkflowPreflight(selectedWorkflowId, workflowVersion)
  const orchestrationPreflight = usePreflight(leadId, allowedFor)

  const routineQueries = useQueries({
    queries: agents.map((agent) => ({
      queryKey: routinesKey(agent.id),
      queryFn: ({ signal }: { signal: AbortSignal }) => fetchRoutines(agent.id, signal),
      retry: false,
    })),
  })
  const scheduled = routineQueries.flatMap((query, index) => {
    const agentId = agents[index]?.id
    return agentId ? (query.data ?? []).map((routine) => ({ ...routine, agentId })) : []
  })

  useEffect(() => {
    dialog.current?.focus()
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault()
        onClose()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [onClose])

  const orchestrationWorkers = orchestrationPreflight.data?.workers ?? []
  const workflowWorkers = workflowPreflight.data?.workers ?? []
  const orchestrationReach = orchestrationWorkers.flatMap((worker) =>
    worker.reachBeyondWorkspace && worker.policyId ? [worker.policyId] : [],
  )
  const workflowReach = workflowWorkers.flatMap((worker) =>
    worker.reachBeyondWorkspace && worker.policyId ? [worker.policyId] : [],
  )
  // A routine or a trigger starts its work through the lead later; only a run started now uses these workers and their
  // reach. Keeping them out of that decision stops a check for a run that is not being started.
  const workersAtStake =
    when === 'once'
      ? recipe.kind === 'workflow'
        ? workflowWorkers
        : recipe.kind === 'lead'
          ? orchestrationWorkers
          : []
      : []
  const reachAtStake = workersAtStake.flatMap((worker) =>
    worker.reachBeyondWorkspace && worker.policyId ? [worker.policyId] : [],
  )
  const reachCovered = reachAtStake.length === 0 || reachAccepted

  const missingInputs =
    recipe.kind === 'workflow' && workflowDefinition
      ? workflowDefinition.inputs.filter(
          (input) => input.required && (inputs[input.name] ?? '').trim() === '',
        )
      : []

  let checks: StartCheck[] = [checkOf(teamRoom)]
  if (recipe.kind === 'workflow') {
    const preflight = workflowPreflight.data
    checks = [
      checkOf(teamRoom),
      ...checksFromPreflight(
        workflow.isPending || workflowPreflight.isPending,
        workflow.isError || workflowPreflight.isError,
        preflight?.checks,
      ),
      ...(preflight?.issues ?? [])
        .filter((issue) => issue.severity === 'error')
        .map((issue) => ({
          key: `issue-${issue.code}-${issue.nodeId ?? ''}`,
          status: 'fail' as const,
          text: issue.message,
        })),
      ...(missingInputs.length
        ? [
            {
              key: 'inputs',
              status: 'fail' as const,
              text: `Fill in ${missingInputs.map((input) => input.label).join(', ')}`,
            },
          ]
        : []),
    ]
  } else if (recipe.kind === 'lead' && when === 'once') {
    const preflight = orchestrationPreflight.data
    checks = [
      ...checks,
      ...checksFromPreflight(
        orchestrationPreflight.isPending,
        orchestrationPreflight.isError,
        preflight?.checks,
      ),
      ...(allowedFor.length === 0
        ? [
            {
              key: 'agents',
              status: 'fail' as const,
              text: 'Choose at least one agent for the steps',
            },
          ]
        : []),
    ]
  } else if (when === 'once') {
    checks.push({ key: 'job', status: 'ok', text: 'The job opens in the team room' })
  } else if (when === 'schedule') {
    checks.push(
      leadId
        ? { key: 'schedule-agent', status: 'ok', text: `The schedule runs as ${leadId}` }
        : { key: 'schedule-agent', status: 'fail', text: 'No agent is available for the schedule' },
      schedule
        ? { key: 'schedule', status: 'ok', text: `It repeats ${schedule.toLowerCase()}` }
        : { key: 'schedule', status: 'fail', text: 'Choose when it repeats' },
    )
  } else {
    checks.push(
      titleOf(what) === 'New job'
        ? {
            key: 'trigger-name',
            status: 'fail',
            text: 'Give the trigger a name or describe the work',
          }
        : {
            key: 'trigger-name',
            status: 'ok',
            text: `It is called ${triggerNameOf(triggerName, what)}`,
          },
      triggerApp.trim()
        ? { key: 'trigger-app', status: 'ok', text: `Calls come from ${triggerApp.trim()}` }
        : { key: 'trigger-app', status: 'fail', text: 'Name the app it comes from' },
    )
  }
  if (when !== 'once' && recipe.kind !== 'lead')
    checks.push({
      key: 'recipe-when',
      status: 'fail',
      text: 'A saved recipe or a plain job runs now; schedules and triggers ask the lead. Choose “lead decides”, or “Now, once”.',
    })
  if (!reachCovered)
    checks.push({
      key: 'reach',
      status: 'fail',
      text: 'Accept what the coding agents can read before you start',
    })

  const checksPass = checks.length > 0 && checks.every((check) => check.status === 'ok')
  const hasWhat = what.trim().length > 0
  const canStart =
    !busy &&
    !result &&
    hasWhat &&
    ack &&
    checksPass &&
    reachCovered &&
    missingInputs.length === 0 &&
    leadId !== ''

  const savedRecipes = workflows.data?.items ?? []

  function chooseRecipe(next: RecipeChoice) {
    setRecipe(next)
    setReachAccepted(false)
    setError(null)
    setResult(null)
  }

  async function start() {
    if (!canStart) return
    setBusy(true)
    setError(null)
    try {
      const title = titleOf(what)
      const deadlineAt = deadlineIso(deadline)
      if (saveRecipe && recipe.kind !== 'workflow') {
        await post('workflows', {
          definition: oneStepRecipe({
            name: orchestrationTitleOf(what),
            instruction: what,
            agentId: leadId,
          }),
        }).then((body) => WorkflowVersionSchema.parse(body))
        await queryClient.invalidateQueries({ queryKey: ['workflows'] })
      }

      if (when === 'webhook') {
        const made = TriggerCreatedSchema.parse(
          await post('triggers', triggerRequest({ name: triggerName, app: triggerApp, what })),
        )
        setResult({
          kind: 'trigger',
          title: made.trigger.name,
          url: made.trigger.url,
          secret: made.secret,
        })
        return
      }

      if (when === 'schedule') {
        const made = RoutineSummarySchema.parse(
          await post(`agents/${encodeURIComponent(leadId)}/routines`, {
            title,
            schedule,
            prompt: what.trim(),
          }),
        )
        await queryClient.invalidateQueries({ queryKey: routinesKey(leadId), exact: true })
        setResult({ kind: 'routine', title: made.title, schedule: made.schedule })
        return
      }

      if (recipe.kind === 'workflow') {
        if (!workflowDefinition || workflowVersion === undefined || !workflowPreflight.data)
          throw new Error('The recipe is not ready yet.')
        const data = workflowPreflight.data
        const codingPolicies = Object.fromEntries(
          workflowWorkers.flatMap((worker) =>
            worker.policyId ? [[worker.agentId, worker.policyId] as const] : [],
          ),
        )
        const body: WorkflowRunCreate = {
          workflowId: recipe.id,
          version: workflowVersion,
          inputs: Object.fromEntries(
            workflowDefinition.inputs.flatMap((input) => {
              const value = (inputs[input.name] ?? '').trim()
              return value ? [[input.name, value] as const] : []
            }),
          ),
          agentMap: data.mapping.map(({ agentId, incarnation }) => ({ agentId, incarnation })),
          gatePolicy: workflowPolicy(ask),
          ...(cap > 0 ? { budgetUsd: cap } : {}),
          ...(deadlineAt ? { deadlineAt } : {}),
          unknownSpend: 'pause',
          maxConcurrentSteps: data.defaults.maxConcurrentSteps,
          stepEstimateUsd: data.defaults.stepEstimateUsd,
          acknowledgement: { text: ORCH_ACKNOWLEDGEMENT_TEXT },
          ...(workflowWorkers.length > 0
            ? {
                codingPolicies,
                codingSteps: data.defaults.codingSteps ?? 1,
                ...(workflowReach.length > 0
                  ? { acknowledgeCodingReach: { policyIds: workflowReach } }
                  : {}),
              }
            : {}),
        }
        const made = WorkflowRunCreatedSchema.parse(await post('workflow-runs', body))
        setResult({ kind: 'workflow', title: made.run.title, runId: made.run.id })
        return
      }

      if (!teamRoom.data) throw new Error('The team room is not ready yet.')
      const job = JobSchema.parse(
        await post(`rooms/${encodeURIComponent(teamRoom.data.room.id)}/jobs`, { title }),
      )
      if (recipe.kind === 'lead') {
        const data = orchestrationPreflight.data
        if (!data) throw new Error('The checks are not ready yet.')
        const codingPolicies = Object.fromEntries(
          orchestrationWorkers.flatMap((worker) =>
            worker.policyId ? [[worker.agentId, worker.policyId] as const] : [],
          ),
        )
        const body: OrchestrationCreate = {
          title: orchestrationTitleOf(what),
          goal: what.trim(),
          leadAgentId: leadId,
          allowedAgents: allowedFor,
          gatePolicy: orchestrationPolicy(ask),
          ...(cap > 0 ? { budgetUsd: cap } : {}),
          ...(deadlineAt ? { deadlineAt } : {}),
          maxSteps: ORCH_DEFAULTS.maxSteps,
          maxLeadTurns: turns,
          maxConcurrentSteps: ORCH_DEFAULTS.maxConcurrentSteps,
          leadTurnEstimateUsd: ORCH_DEFAULTS.leadTurnEstimateUsd,
          stepEstimateUsd: ORCH_DEFAULTS.stepEstimateUsd,
          acknowledgement: { text: ORCH_ACKNOWLEDGEMENT_TEXT },
          ...(orchestrationWorkers.length > 0
            ? {
                codingPolicies,
                codingSteps: ORCH_DEFAULTS.codingSteps,
                ...(orchestrationReach.length > 0
                  ? { acknowledgeCodingReach: { policyIds: orchestrationReach } }
                  : {}),
              }
            : {}),
        }
        const made = OrchestrationCreatedSchema.parse(await post('orchestrations', body))
        setResult({
          kind: 'job',
          title,
          jobId: job.id,
          orchestrationId: made.orchestration.id,
        })
      } else {
        setResult({ kind: 'job', title, jobId: job.id })
      }
    } catch (failure) {
      setError(startError(failure))
    } finally {
      setBusy(false)
    }
  }

  return (
    <div
      className="bold-start-scrim"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose()
      }}
    >
      <div
        ref={dialog}
        className="dialog bold-start-dialog"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
        data-protected="block"
        data-decision
      >
        <div className="row">
          <h2 id={titleId} className="grow start-title">
            Start a job
          </h2>
          <button
            ref={closeButton}
            type="button"
            className="icon-btn"
            aria-label="Close"
            onClick={onClose}
          >
            <CloseIcon />
          </button>
        </div>

        {result ? (
          <ResultCard result={result} onClose={onClose} />
        ) : (
          <>
            <div>
              <label htmlFor="start-what" className="lab">
                What should the team do?
              </label>
              <textarea
                id="start-what"
                className="field start-what"
                rows={2}
                maxLength={4000}
                value={what}
                onChange={(event) => setWhat(event.target.value)}
                autoFocus
              />
            </div>

            <div>
              <span className="lab">Recipe</span>
              <div className="row wrap" role="radiogroup" aria-label="Recipe">
                <RecipeChip
                  chosen={recipe.kind === 'lead'}
                  label="lead decides"
                  onClick={() => chooseRecipe({ kind: 'lead' })}
                />
                <RecipeChip
                  chosen={recipe.kind === 'none'}
                  label="None"
                  onClick={() => chooseRecipe({ kind: 'none' })}
                />
                {savedRecipes.map((item) => (
                  <RecipeChip
                    key={item.id}
                    chosen={recipe.kind === 'workflow' && recipe.id === item.id}
                    label={item.name}
                    onClick={() => chooseRecipe({ kind: 'workflow', id: item.id, name: item.name })}
                  />
                ))}
                <button
                  type="button"
                  className="link"
                  disabled
                  title="The recipe editor comes in 11.10d"
                >
                  Edit recipes
                </button>
              </div>
              {recipe.kind === 'workflow' && workflowDefinition && (
                <div className="inner start-recipe-preview">
                  <span className="small muted">
                    {recipe.name} · version {workflowVersion}
                  </span>
                  <span className="small">
                    {workflowDefinition.nodes
                      .filter((node) => node.kind === 'agent')
                      .map((node) => node.label)
                      .join(' → ')}
                  </span>
                </div>
              )}
            </div>

            {recipe.kind === 'lead' && when === 'once' && (
              <>
                <div className="row wrap start-lead">
                  {leadAgent && (
                    <span className="chip start-agent-chip">
                      <AgentGlyph agent={leadAgent} size="sm" plain bare decorative />
                      <span>{leadAgent.name} plans</span>
                    </span>
                  )}
                  <span className="small muted">
                    The lead decides the steps and hands them out.
                  </span>
                </div>
                <AgentPick
                  agents={agents}
                  leadId={leadId}
                  chosen={allowedFor}
                  onChange={setAllowed}
                />
              </>
            )}

            <div className="grid3 start-when">
              <fieldset className="inner" style={{ border: 0, margin: 0 }}>
                <legend className="lab start-legend">When</legend>
                <div className="start-clear">
                  {(
                    [
                      ['once', 'Now, once'],
                      ['schedule', 'On a schedule'],
                      ['webhook', 'When another app calls'],
                    ] as const
                  ).map(([id, label]) => (
                    <label className="check" key={id}>
                      <input
                        type="radio"
                        name="start-when"
                        checked={when === id}
                        onChange={() => {
                          setWhen(id)
                          setError(null)
                          setResult(null)
                        }}
                      />
                      {label}
                    </label>
                  ))}
                </div>
                {when === 'schedule' && (
                  <label className="start-field">
                    <span className="sr">Schedule</span>
                    <select
                      className="field"
                      aria-label="Schedule"
                      value={schedule}
                      onChange={(event) => setSchedule(event.target.value)}
                    >
                      {SCHEDULES.map((option) => (
                        <option key={option}>{option}</option>
                      ))}
                    </select>
                  </label>
                )}
                {when === 'webhook' && (
                  <div className="start-trigger-fields">
                    <label className="start-field">
                      <span className="lab">Trigger name</span>
                      <input
                        className="field"
                        maxLength={100}
                        value={triggerName}
                        placeholder="e.g. New support ticket"
                        onChange={(event) => setTriggerName(event.target.value)}
                      />
                    </label>
                    <label className="start-field">
                      <span className="lab">The app it comes from</span>
                      <input
                        className="field"
                        maxLength={100}
                        value={triggerApp}
                        onChange={(event) => setTriggerApp(event.target.value)}
                      />
                    </label>
                    <span className="small muted">
                      Calls send <code>ref</code>, and may send <code>title</code>,{' '}
                      <code>link</code> and <code>details</code>. The address and secret are made
                      when you start.
                    </span>
                  </div>
                )}
              </fieldset>

              <fieldset className="inner" style={{ border: 0, margin: 0 }}>
                <legend className="lab start-legend">Ask me before</legend>
                <div className="start-clear">
                  {(
                    [
                      ['plan', 'The plan starts'],
                      ['handoff', 'Every hand-off'],
                      ['risky', 'Only risky actions'],
                    ] as const
                  ).map(([id, label]) => (
                    <label className="check" key={id}>
                      <input
                        type="radio"
                        name="start-ask"
                        checked={ask === id}
                        onChange={() => setAsk(id)}
                      />
                      {label}
                    </label>
                  ))}
                </div>
              </fieldset>

              <div className="inner start-limits">
                <span className="lab">Limits</span>
                <label htmlFor="start-turns" className="row small">
                  <span className="grow">Turns per back-and-forth</span>
                  <b>{turns}</b>
                </label>
                <input
                  id="start-turns"
                  type="range"
                  min={2}
                  max={20}
                  value={turns}
                  onChange={(event) => setTurns(Number(event.target.value))}
                  style={{ accentColor: 'var(--ink)' }}
                />
                <label htmlFor="start-cap" className="row small">
                  <span className="grow">Spend cap</span>
                  <b>{cap > 0 ? `$${cap.toFixed(2)}` : 'No cap'}</b>
                </label>
                <input
                  id="start-cap"
                  type="range"
                  min={0}
                  max={20}
                  value={cap}
                  onChange={(event) => setCap(Number(event.target.value))}
                  style={{ accentColor: 'var(--ink)' }}
                />
                <label htmlFor="start-deadline" className="lab start-deadline">
                  Deadline
                </label>
                <input
                  id="start-deadline"
                  type="time"
                  className="field"
                  value={deadline}
                  onChange={(event) => setDeadline(event.target.value)}
                />
              </div>
            </div>

            {recipe.kind === 'workflow' && workflowDefinition?.inputs.length ? (
              <fieldset className="inner start-inputs">
                <legend className="lab start-legend">Inputs</legend>
                {workflowDefinition.inputs.map((input) => (
                  <label key={input.name} className="start-field">
                    <span>
                      {input.label}
                      {input.required ? '' : ' (optional)'}
                    </span>
                    <textarea
                      className="field"
                      rows={input.maxChars > 200 ? 3 : 1}
                      maxLength={input.maxChars}
                      required={input.required}
                      value={inputs[input.name] ?? ''}
                      onChange={(event) =>
                        setInputs((current) => ({ ...current, [input.name]: event.target.value }))
                      }
                    />
                  </label>
                ))}
              </fieldset>
            ) : null}

            <Checklist checks={checks}>
              {workersAtStake.length > 0 && (
                <div className="start-reach" data-protected="block">
                  <b className="small">Coding agents in this job</b>
                  {workersAtStake.map((worker) => (
                    <span key={worker.agentId} className="small muted">
                      {worker.agentId}: {worker.reach ?? worker.detail ?? worker.readiness}
                    </span>
                  ))}
                  {reachAtStake.length > 0 && (
                    <label className="check small">
                      <input
                        type="checkbox"
                        checked={reachAccepted}
                        onChange={(event) => setReachAccepted(event.target.checked)}
                      />
                      I understand what these coding agents can read, and I accept it for this job.
                    </label>
                  )}
                </div>
              )}
              <label className="check small start-ack">
                <input
                  type="checkbox"
                  checked={ack}
                  onChange={(event) => setAck(event.target.checked)}
                />
                {ORCH_ACKNOWLEDGEMENT_TEXT}
              </label>
            </Checklist>

            {scheduled.length > 0 && (
              <section className="inner start-scheduled" aria-label="Scheduled">
                <span className="lab">Scheduled</span>
                <ul>
                  {scheduled.map((item) => (
                    <li key={item.id} className="row small">
                      <span className="grow">{item.title}</span>
                      <span className="muted">
                        {item.agentId} · {item.schedule}
                        {item.enabled ? '' : ' · paused'}
                      </span>
                    </li>
                  ))}
                </ul>
              </section>
            )}

            {error && (
              <p className="start-error" role="alert">
                {error}
              </p>
            )}

            <div className="row wrap start-actions">
              {recipe.kind !== 'workflow' && (
                <label className="check small">
                  <input
                    type="checkbox"
                    checked={saveRecipe}
                    onChange={(event) => setSaveRecipe(event.target.checked)}
                  />
                  Save as a recipe
                </label>
              )}
              <button type="button" className="btn ghost start-cancel" onClick={onClose}>
                Cancel
              </button>
              <button
                type="button"
                className="btn primary start-go"
                disabled={!canStart}
                onClick={() => void start()}
              >
                {busy ? 'Starting…' : 'Start the job'}
              </button>
            </div>
          </>
        )}
      </div>
    </div>
  )
}

function RecipeChip({
  chosen,
  label,
  onClick,
}: {
  chosen: boolean
  label: string
  onClick: () => void
}) {
  return (
    <button
      type="button"
      className={`chip ${chosen ? 'on' : ''}`}
      role="radio"
      aria-checked={chosen}
      onClick={onClick}
      style={{ background: chosen ? undefined : 'var(--field)' }}
    >
      {label}
    </button>
  )
}

function ResultCard({ result, onClose }: { result: Result; onClose: () => void }) {
  if (result.kind === 'trigger') {
    return (
      <div className="start-result">
        <h3>Trigger created</h3>
        <p className="muted">
          Send the app’s calls to this address. The secret is shown once; copy it now.
        </p>
        <div className="inner start-secret" data-protected="block">
          <span className="lab">Address</span>
          <div className="row wrap">
            <code className="grow">{result.url ?? 'Score is reachable only on this machine'}</code>
            {result.url && <CopyButton text={result.url} label="Copy address" />}
          </div>
          <span className="lab">Signing secret</span>
          <div className="row wrap">
            <code className="grow">{result.secret}</code>
            <CopyButton text={result.secret} label="Copy secret" />
          </div>
          <span className="small muted">
            Calls must be signed with the secret and arrive within five minutes.
          </span>
        </div>
        <div className="row wrap start-actions">
          <button type="button" className="btn primary start-cancel" onClick={onClose}>
            Done
          </button>
        </div>
      </div>
    )
  }
  const detail =
    result.kind === 'job'
      ? result.orchestrationId
        ? 'The lead is planning it in an orchestration.'
        : 'It is waiting in the team room for you.'
      : result.kind === 'workflow'
        ? 'The recipe is running in its own room.'
        : `It repeats ${result.schedule.toLowerCase()}.`
  return (
    <div className="start-result">
      <h3>{result.kind === 'routine' ? 'Scheduled' : 'Started'}</h3>
      <p>
        <b>{result.title}</b>
      </p>
      <p className="muted">{detail}</p>
      <div className="row wrap start-actions">
        <button type="button" className="btn primary start-cancel" onClick={onClose}>
          Done
        </button>
      </div>
    </div>
  )
}

function CopyButton({ text, label }: { text: string; label: string }) {
  return (
    <button type="button" className="btn sm" onClick={() => void copyText(text)}>
      {label}
    </button>
  )
}

function startError(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'conflict') return error.message
    if (error.code === 'paused') return 'Work is paused. Resume the team or the agent first.'
    if (error.code === 'no_lead') return 'The team room has no lead yet.'
  }
  if (error instanceof Error && error.message) return error.message
  return describeCreateError(error)
}
