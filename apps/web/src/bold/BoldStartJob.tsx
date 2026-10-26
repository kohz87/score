import {
  JobSchema,
  ORCH_ACKNOWLEDGEMENT_TEXT,
  ORCH_DEFAULTS,
  OrchestrationCreatedSchema,
  RoutineSummarySchema,
  TriggerCreatedSchema,
  WorkflowRunCreatedSchema,
  WorkflowVersionSchema,
  type AgentSummary,
  type CostSource,
  type OrchestrationCreate,
  type WorkflowRunCreate,
} from '@score/contract'
import { useQueries, useQueryClient } from '@tanstack/react-query'
import {
  createContext,
  useContext,
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react'
import { Link, useLocation, useNavigate } from 'react-router'
import { AgentGlyph } from '../components/AgentGlyph.tsx'
import { apiFetch, ApiError } from '../data/api.ts'
import { copyText } from '../data/clipboard.ts'
import { newId } from '../data/ids.ts'
import { useStreamQuery } from '../data/query-client.ts'
import { teamRoomQuery } from './room/room-queries.ts'
import { pairingProblem } from './bold-errors.ts'
import { agentsQuery } from '../routes/chat/queries.ts'
import { describeCreateError } from '../routes/orchestrations/NewOrchestrationDialog.tsx'
import { usePreflight } from '../routes/orchestrations/orchestration-queries.ts'
import { sourceName } from '../routes/orchestrations/decision-parts.tsx'
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
  scheduleLabel,
  scheduleValue,
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
  | { kind: 'workflow'; title: string; runId: string; jobId?: string }
  | { kind: 'routine'; title: string; schedule: string }
  | { kind: 'trigger'; title: string; url: string | null; secret: string }

type JobLimits = {
  exchangeBudget?: number
  jobTurnLimit?: number
  spendCapUsd?: number
}

/** What exists if the second step of a start fails: the run, the job yet to make, and the link to the run. */
type PartialJob = {
  kind: 'orchestration' | 'workflow'
  ref: string
  title: string
  briefId: string
  jobTitle: string
  limits: JobLimits
}

const NO_AGENTS: AgentSummary[] = []
/** The contract's default for a job's whole turn budget; a plain job's exchange slider is per back-and-forth. */
const JOB_TURN_LIMIT = 40

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
              <AgentGlyph agent={agent} size="sm" bare decorative />
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
  const navigate = useNavigate()
  const location = useLocation()
  const queryClient = useQueryClient()
  const agents = useStreamQuery(agentsQuery).data ?? NO_AGENTS
  const workflows = useWorkflows()
  // The same stream-kept read of the team room as the room and Results (one cache entry, one reducer).
  const teamRoomState = useStreamQuery(teamRoomQuery(null))
  const teamRoom = {
    data: teamRoomState.data,
    isPending: teamRoomState.status === 'pending',
    isError: teamRoomState.status === 'error',
  }

  const [what, setWhat] = useState('')
  // When the dialog opened: a deadline before it is already past (read once, not on every render).
  const [openedAt] = useState(() => Date.now())
  const [recipe, setRecipe] = useState<RecipeChoice>({ kind: 'lead' })
  const [when, setWhen] = useState<When>('once')
  const [ask, setAsk] = useState<Ask>('risky')
  const [turns, setTurns] = useState(8)
  const [cap, setCap] = useState(5)
  const [deadlineEnabled, setDeadlineEnabled] = useState(false)
  const [deadline, setDeadline] = useState('')
  const [schedule, setSchedule] = useState<string>(SCHEDULES[0].label)
  const [triggerApp, setTriggerApp] = useState('Another app')
  const [triggerName, setTriggerName] = useState('')
  const [unknownSpend, setUnknownSpend] = useState<'pause' | 'continue'>('pause')
  const [unknownCost, setUnknownCost] = useState<CostSource[]>([])
  const [ack, setAck] = useState(false)
  const [reachAccepted, setReachAccepted] = useState(false)
  const [saveRecipe, setSaveRecipe] = useState(false)
  const [inputs, setInputs] = useState<Record<string, string>>({})
  const [allowed, setAllowed] = useState<string[] | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [result, setResult] = useState<Result | null>(null)
  const [partial, setPartial] = useState<PartialJob | null>(null)
  const [saveWarning, setSaveWarning] = useState<string | null>(null)
  const [dirty, setDirty] = useState(false)
  const [confirmClose, setConfirmClose] = useState(false)
  // One key for one start attempt; a retry of the job step replays instead of making a second run or job.
  const attemptKey = useRef<string | null>(null)
  const starting = useRef(false)
  const savedRecipeName = useRef<string | null>(null)
  const returnFocus = useRef<HTMLElement | null>(null)
  const recipeButtons = useRef(new Map<string, HTMLButtonElement>())

  const hermesAgents = agents.filter((agent) => !agent.runtime || agent.runtime === 'hermes')
  const teamLead = teamRoom.data?.room.leadAgentId ?? null
  const leadId =
    (teamLead && hermesAgents.some((agent) => agent.id === teamLead)
      ? teamLead
      : hermesAgents[0]?.id) ?? ''
  const defaultAllowed = agents.filter((agent) => agent.id !== leadId).map((agent) => agent.id)
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
    returnFocus.current =
      document.activeElement instanceof HTMLElement ? document.activeElement : null
    dialog.current?.focus()
    return () => {
      const opener = returnFocus.current
      if (opener?.isConnected) opener.focus()
    }
  }, [])

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

  const nowOnce = when === 'once'
  const isLead = nowOnce && recipe.kind === 'lead'
  const isPlain = nowOnce && recipe.kind === 'none'
  const isSavedRecipe = nowOnce && recipe.kind === 'workflow'
  const showWhat = !isSavedRecipe
  const showRecipe = nowOnce
  const showAsk = nowOnce && !isPlain
  const showDeadline = nowOnce && !isPlain
  const showUnknownCost = nowOnce && isSavedRecipe
  const showSaveRecipe = nowOnce && !isSavedRecipe
  const jobTitle = isSavedRecipe && nowOnce ? titleOf(recipe.name) : titleOf(what)
  const saveName = orchestrationTitleOf(what)
  const deadlineAt = deadlineEnabled ? deadlineIso(deadline) : undefined
  const deadlinePast = deadlineAt !== undefined && Date.parse(deadlineAt) <= openedAt

  const missingInputs =
    isSavedRecipe && workflowDefinition
      ? workflowDefinition.inputs.filter(
          (input) => input.required && (inputs[input.name] ?? '').trim() === '',
        )
      : []

  let checks: StartCheck[] = []
  if (isSavedRecipe) {
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
  } else if (isLead && nowOnce) {
    const preflight = orchestrationPreflight.data
    checks = [
      checkOf(teamRoom),
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
  } else if (nowOnce) {
    checks = [
      checkOf(teamRoom),
      { key: 'job', status: 'ok', text: 'The job opens in the team room' },
    ]
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
  if (showDeadline && deadlineEnabled) {
    checks.push({
      key: 'deadline',
      status: deadlineAt && !deadlinePast ? 'ok' : 'fail',
      text: !deadlineAt
        ? 'Pick a deadline date and time'
        : deadlinePast
          ? 'Pick a deadline in the future'
          : 'The run stops if that deadline passes',
    })
  }
  if (!reachCovered)
    checks.push({
      key: 'reach',
      status: 'fail',
      text: 'Accept what the coding agents can read before you start',
    })

  const checksPass = checks.length > 0 && checks.every((check) => check.status === 'ok')
  const hasWhat = (isSavedRecipe && nowOnce) || what.trim().length > 0
  const needsLead = isLead || when === 'schedule'
  const canStart =
    !busy &&
    !result &&
    !partial &&
    hasWhat &&
    ack &&
    checksPass &&
    reachCovered &&
    missingInputs.length === 0 &&
    (!needsLead || leadId !== '')

  const savedRecipes = workflows.data?.items ?? []
  // `?recipe=<id>` (the Recipes page's Run) opens the dialog with that saved recipe already chosen, once.
  const wantedRecipe = new URLSearchParams(location.search).get('recipe')
  const appliedWanted = useRef(false)
  const wantedItem = wantedRecipe
    ? savedRecipes.find((item) => item.id === wantedRecipe)
    : undefined
  useEffect(() => {
    if (!wantedItem || appliedWanted.current) return
    appliedWanted.current = true
    setRecipe({ kind: 'workflow', id: wantedItem.id, name: wantedItem.name })
  }, [wantedItem])
  const recipeOptions: { key: string; label: string; choice: RecipeChoice }[] = [
    { key: 'lead', label: 'lead decides', choice: { kind: 'lead' } },
    { key: 'none', label: 'None', choice: { kind: 'none' } },
    ...savedRecipes.map((item) => ({
      key: `workflow:${item.id}`,
      label: item.name,
      choice: { kind: 'workflow' as const, id: item.id, name: item.name },
    })),
  ]

  /** A real radio group: one tab stop, arrows move and choose the next chip. */
  function onRecipeKeyDown(event: KeyboardEvent<HTMLButtonElement>, key: string) {
    const index = recipeOptions.findIndex((option) => option.key === key)
    if (index < 0) return
    const last = recipeOptions.length - 1
    let next: number
    if (event.key === 'ArrowRight' || event.key === 'ArrowDown')
      next = index === last ? 0 : index + 1
    else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp')
      next = index === 0 ? last : index - 1
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = last
    else return
    event.preventDefault()
    const option = recipeOptions[next]
    if (!option) return
    chooseRecipe(option.choice)
    recipeButtons.current.get(option.key)?.focus()
  }

  function touch() {
    setDirty(true)
    setConfirmClose(false)
    attemptKey.current = null
  }

  /** One key for one attempt: a replayed request returns the first answer, and a retry never makes a second run. */
  function attemptPost(path: string, body: unknown) {
    const key = attemptKey.current ?? newId()
    attemptKey.current = key
    return apiFetch(path, {
      method: 'POST',
      headers: { 'Idempotency-Key': key },
      body: JSON.stringify(body),
    })
  }

  function requestClose() {
    if ((result?.kind === 'trigger' && !confirmClose) || (!result && !partial && dirty)) {
      setConfirmClose(true)
      return
    }
    onClose()
  }

  function onDialogKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'Escape') {
      event.preventDefault()
      requestClose()
      return
    }
    if (event.key !== 'Tab') return
    const controls = [
      ...(dialog.current?.querySelectorAll<HTMLElement>(
        'input:not([disabled]), button:not([disabled]), select:not([disabled]), textarea:not([disabled]), a[href]',
      ) ?? []),
    ].filter((element) => element.tabIndex >= 0)
    const first = controls[0]
    const last = controls[controls.length - 1]
    if (!first || !last) return
    const active = document.activeElement
    if (event.shiftKey && (active === first || active === dialog.current)) {
      event.preventDefault()
      last.focus()
    } else if (!event.shiftKey && (active === last || active === dialog.current)) {
      event.preventDefault()
      first.focus()
    }
  }

  function chooseRecipe(next: RecipeChoice) {
    setRecipe(next)
    setReachAccepted(false)
    setError(null)
    setResult(null)
    setPartial(null)
    touch()
  }

  function jobLimits(): JobLimits {
    if (!nowOnce || isSavedRecipe) return {}
    return {
      exchangeBudget: turns,
      jobTurnLimit: JOB_TURN_LIMIT,
      ...(cap > 0 ? { spendCapUsd: cap } : {}),
    }
  }

  async function createJob(
    title: string,
    limits: JobLimits,
    recipeLink?: { kind: 'orchestration' | 'workflow'; ref: string },
  ) {
    if (!teamRoom.data) throw new Error('The team room is not ready yet.')
    return JobSchema.parse(
      await attemptPost(`rooms/${encodeURIComponent(teamRoom.data.room.id)}/jobs`, {
        title,
        ...limits,
        ...(recipeLink ? { recipe: recipeLink } : {}),
      }),
    )
  }

  async function startOrchestration() {
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
    return OrchestrationCreatedSchema.parse(await attemptPost('orchestrations', body))
  }

  async function startWorkflow() {
    if (recipe.kind !== 'workflow') throw new Error('The recipe is not ready yet.')
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
      unknownSpend,
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
            ...(unknownSpend === 'pause' && unknownCost.length > 0
              ? { acceptUnknownCost: unknownCost }
              : {}),
          }
        : {}),
    }
    return WorkflowRunCreatedSchema.parse(await attemptPost('workflow-runs', body))
  }

  async function createLinkedJob(
    kind: PartialJob['kind'],
    ref: string,
    briefId: string,
    runTitle: string,
    title: string,
  ) {
    const limits = jobLimits()
    try {
      const job = await createJob(title, limits, { kind, ref })
      return { job, limits }
    } catch (failure) {
      setPartial({ kind, ref, briefId, title: runTitle, jobTitle: title, limits })
      setError(startError(failure))
      return null
    }
  }

  /** Saving a recipe happens after the work exists: a failed start must not leave a recipe behind. */
  async function saveRecipeAfterStart() {
    if (!saveRecipe || !showSaveRecipe || !leadId) return
    if (savedRecipeName.current === saveName) return
    savedRecipeName.current = saveName
    try {
      await attemptPost('workflows', {
        definition: oneStepRecipe({ name: saveName, instruction: what, agentId: leadId }),
      }).then((body) => WorkflowVersionSchema.parse(body))
      await queryClient.invalidateQueries({ queryKey: ['workflows'] })
      if (savedRecipes.some((item) => item.name === saveName))
        setSaveWarning(`Saved “${saveName}” again; a recipe with that name already existed.`)
    } catch (failure) {
      setSaveWarning(`It started, but saving the recipe failed: ${startError(failure)}`)
    }
  }

  async function start() {
    if (!canStart || starting.current) return
    starting.current = true
    setBusy(true)
    setError(null)
    setPartial(null)
    setSaveWarning(null)
    try {
      const title = jobTitle
      if (when === 'webhook') {
        const made = TriggerCreatedSchema.parse(
          await attemptPost(
            'triggers',
            triggerRequest({ name: triggerName, app: triggerApp, what }),
          ),
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
          await attemptPost(`agents/${encodeURIComponent(leadId)}/routines`, {
            title,
            schedule: scheduleValue(schedule),
            prompt: what.trim(),
          }),
        )
        await queryClient.invalidateQueries({ queryKey: routinesKey(leadId), exact: true })
        setResult({ kind: 'routine', title: made.title, schedule })
        return
      }

      if (isSavedRecipe) {
        const made = await startWorkflow()
        const linked = await createLinkedJob(
          'workflow',
          made.run.id,
          made.run.briefId,
          made.run.title,
          title,
        )
        if (!linked) return
        setResult({
          kind: 'workflow',
          title: made.run.title,
          runId: made.run.id,
          jobId: linked.job.id,
        })
      } else if (isLead) {
        const made = await startOrchestration()
        const linked = await createLinkedJob(
          'orchestration',
          made.orchestration.id,
          made.orchestration.briefId,
          made.orchestration.title,
          title,
        )
        if (!linked) return
        setResult({
          kind: 'job',
          title,
          jobId: linked.job.id,
          orchestrationId: made.orchestration.id,
        })
      } else {
        const job = await createJob(title, jobLimits())
        setResult({ kind: 'job', title, jobId: job.id })
      }
      await saveRecipeAfterStart()
    } catch (failure) {
      setError(startError(failure))
    } finally {
      starting.current = false
      setBusy(false)
    }
  }

  async function createJobAgain() {
    if (!partial || starting.current) return
    const pending = partial
    starting.current = true
    setBusy(true)
    setError(null)
    try {
      const job = await createJob(pending.jobTitle, pending.limits, {
        kind: pending.kind,
        ref: pending.ref,
      })
      setPartial(null)
      if (pending.kind === 'orchestration')
        setResult({
          kind: 'job',
          title: pending.jobTitle,
          jobId: job.id,
          orchestrationId: pending.ref,
        })
      else
        setResult({
          kind: 'workflow',
          title: pending.title,
          runId: pending.ref,
          jobId: job.id,
        })
      await saveRecipeAfterStart()
    } catch (failure) {
      setError(startError(failure))
    } finally {
      starting.current = false
      setBusy(false)
    }
  }

  return (
    <div
      className="bold-start-scrim"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) requestClose()
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
        onKeyDown={onDialogKeyDown}
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
            onClick={requestClose}
          >
            <CloseIcon />
          </button>
        </div>

        {confirmClose && (
          <CloseConfirm
            secret={result?.kind === 'trigger'}
            onKeep={() => setConfirmClose(false)}
            onClose={onClose}
          />
        )}

        {result ? (
          <ResultCard result={result} saveWarning={saveWarning} onClose={onClose} />
        ) : partial ? (
          <PartialCard
            partial={partial}
            busy={busy}
            error={error}
            onRetry={() => void createJobAgain()}
            onClose={onClose}
          />
        ) : (
          <>
            {showWhat && (
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
                  onChange={(event) => {
                    setWhat(event.target.value)
                    touch()
                  }}
                  autoFocus
                />
              </div>
            )}

            {showRecipe && (
              <div>
                <span className="lab">Recipe</span>
                <div className="row wrap" role="radiogroup" aria-label="Recipe">
                  {recipeOptions.map((option) => {
                    const chosen =
                      option.choice.kind === 'workflow'
                        ? isSavedRecipe &&
                          recipe.kind === 'workflow' &&
                          recipe.id === option.choice.id
                        : recipe.kind === option.choice.kind
                    return (
                      <RecipeChip
                        key={option.key}
                        chosen={chosen}
                        label={option.label}
                        tabIndex={chosen ? 0 : -1}
                        buttonRef={(element) => {
                          if (element) recipeButtons.current.set(option.key, element)
                          else recipeButtons.current.delete(option.key)
                        }}
                        onKeyDown={(event) => onRecipeKeyDown(event, option.key)}
                        onClick={() => chooseRecipe(option.choice)}
                      />
                    )
                  })}
                  <Link
                    className="link"
                    to="/b/recipes"
                    onClick={() => {
                      onClose()
                      void navigate('/b/recipes')
                    }}
                  >
                    Edit recipes
                  </Link>
                </div>
                {isSavedRecipe && workflowDefinition && (
                  <div className="inner start-recipe-preview">
                    <span className="small muted">
                      {recipe.kind === 'workflow' ? recipe.name : 'Recipe'} · version{' '}
                      {workflowVersion}
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
            )}

            {isLead && (
              <>
                <div className="row wrap start-lead">
                  {leadAgent && (
                    <span className="chip start-agent-chip">
                      <AgentGlyph agent={leadAgent} size="sm" bare decorative />
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
                  onChange={(next) => {
                    setAllowed(next)
                    touch()
                  }}
                />
              </>
            )}

            <div
              className={`start-controls start-controls--${!nowOnce ? 1 : showAsk ? 3 : 2} start-when`}
            >
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
                          setPartial(null)
                          touch()
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
                      onChange={(event) => {
                        setSchedule(event.target.value)
                        touch()
                      }}
                    >
                      {SCHEDULES.map((option) => (
                        <option key={option.label}>{option.label}</option>
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
                        onChange={(event) => {
                          setTriggerName(event.target.value)
                          touch()
                        }}
                      />
                    </label>
                    <label className="start-field">
                      <span className="lab">The app it comes from</span>
                      <input
                        className="field"
                        maxLength={100}
                        value={triggerApp}
                        onChange={(event) => {
                          setTriggerApp(event.target.value)
                          touch()
                        }}
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

              {showAsk && (
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
                          onChange={() => {
                            setAsk(id)
                            touch()
                          }}
                        />
                        {label}
                      </label>
                    ))}
                  </div>
                </fieldset>
              )}

              {nowOnce && (
                <div className="inner start-limits">
                  <span className="lab">{isSavedRecipe ? 'Budget and deadline' : 'Limits'}</span>
                  {!isSavedRecipe && (
                    <>
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
                        onChange={(event) => {
                          setTurns(Number(event.target.value))
                          touch()
                        }}
                        style={{ accentColor: 'var(--ink)' }}
                      />
                    </>
                  )}
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
                    onChange={(event) => {
                      setCap(Number(event.target.value))
                      touch()
                    }}
                    style={{ accentColor: 'var(--ink)' }}
                  />
                  {showDeadline && (
                    <div className="start-deadline-block">
                      <div className="row small">
                        <span className="grow">Deadline</span>
                        <b>
                          {deadlineEnabled ? deadline || 'Pick a date and time' : 'No deadline'}
                        </b>
                      </div>
                      <label className="check small">
                        <input
                          type="checkbox"
                          checked={deadlineEnabled}
                          onChange={(event) => {
                            setDeadlineEnabled(event.target.checked)
                            touch()
                          }}
                        />
                        Set a deadline
                      </label>
                      {deadlineEnabled && (
                        <input
                          id="start-deadline"
                          type="datetime-local"
                          className="field"
                          aria-label="Deadline date and time"
                          value={deadline}
                          onChange={(event) => {
                            setDeadline(event.target.value)
                            touch()
                          }}
                        />
                      )}
                      <span className="small muted">If the deadline passes, the run stops.</span>
                    </div>
                  )}
                  {isPlain && (
                    <span className="small muted">
                      A plain job has no plan to approve and no run deadline.
                    </span>
                  )}
                </div>
              )}
            </div>

            {showUnknownCost && (
              <fieldset className="inner start-unknown" data-protected="block">
                <legend className="lab start-legend">
                  When Hermes doesn’t say what a step cost
                </legend>
                <div className="start-clear">
                  <label className="check small">
                    <input
                      type="radio"
                      name="start-unknown"
                      checked={unknownSpend === 'pause'}
                      onChange={() => {
                        setUnknownSpend('pause')
                        touch()
                      }}
                    />
                    Pause the run and ask me (when a budget is set)
                  </label>
                  <label className="check small">
                    <input
                      type="radio"
                      name="start-unknown"
                      checked={unknownSpend === 'continue'}
                      onChange={() => {
                        setUnknownSpend('continue')
                        touch()
                      }}
                    />
                    Keep going (unknown spend is never counted as zero)
                  </label>
                  {workflowPreflight.data && (
                    <span className="small muted">{workflowPreflight.data.spendNote}</span>
                  )}
                  {unknownSpend === 'pause' &&
                    [...new Set(workflowWorkers.map((worker) => worker.runtime))].map((source) => (
                      <label key={source} className="check small">
                        <input
                          type="checkbox"
                          checked={unknownCost.includes(source)}
                          onChange={(event) => {
                            setUnknownCost((list) =>
                              event.target.checked
                                ? [...list, source]
                                : list.filter((item) => item !== source),
                            )
                            touch()
                          }}
                        />
                        Keep going when the cost of {sourceName(source)} is unknown
                      </label>
                    ))}
                </div>
              </fieldset>
            )}

            {isSavedRecipe && workflowDefinition?.inputs.length ? (
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
                      onChange={(event) => {
                        setInputs((current) => ({ ...current, [input.name]: event.target.value }))
                        touch()
                      }}
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
                        onChange={(event) => {
                          setReachAccepted(event.target.checked)
                          touch()
                        }}
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
                  onChange={(event) => {
                    setAck(event.target.checked)
                    touch()
                  }}
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
                        {item.agentId} · {scheduleLabel(item.schedule)}
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
              {showSaveRecipe && (
                <div className="start-save-recipe">
                  <label className="check small">
                    <input
                      type="checkbox"
                      checked={saveRecipe}
                      onChange={(event) => {
                        setSaveRecipe(event.target.checked)
                        touch()
                      }}
                    />
                    Save as a recipe
                  </label>
                  {saveRecipe && savedRecipes.some((item) => item.name === saveName) && (
                    <span className="small muted" role="status">
                      A recipe called “{saveName}” already exists; saving adds another.
                    </span>
                  )}
                </div>
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
  tabIndex,
  buttonRef,
  onKeyDown,
}: {
  chosen: boolean
  label: string
  onClick: () => void
  tabIndex: number
  buttonRef: (element: HTMLButtonElement | null) => void
  onKeyDown: (event: KeyboardEvent<HTMLButtonElement>) => void
}) {
  return (
    <button
      ref={buttonRef}
      type="button"
      className={`chip ${chosen ? 'on' : ''}`}
      role="radio"
      aria-checked={chosen}
      tabIndex={tabIndex}
      onClick={onClick}
      onKeyDown={onKeyDown}
      style={{ background: chosen ? undefined : 'var(--field)' }}
    >
      {label}
    </button>
  )
}

function ResultCard({
  result,
  saveWarning,
  onClose,
}: {
  result: Result
  saveWarning: string | null
  onClose: () => void
}) {
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
            Calls must be signed with the secret and arrive within five minutes. You can show the
            secret again from Settings › Tools and triggers.
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
      {saveWarning && (
        <p className="small muted" role="status">
          {saveWarning}
        </p>
      )}
      <div className="row wrap start-actions">
        <button type="button" className="btn primary start-cancel" onClick={onClose}>
          Done
        </button>
      </div>
    </div>
  )
}

function PartialCard({
  partial,
  busy,
  error,
  onRetry,
  onClose,
}: {
  partial: PartialJob
  busy: boolean
  error: string | null
  onRetry: () => void
  onClose: () => void
}) {
  const what = partial.kind === 'orchestration' ? 'orchestration' : 'workflow run'
  return (
    <div className="start-result">
      <h3>{partial.kind === 'orchestration' ? 'Orchestration created' : 'Recipe run started'}</h3>
      <p>
        <b>{partial.title}</b> exists. The job in the team room was not created.
      </p>
      <p className="muted">
        The {what} is real and will not be started again. Create the job again to link it.
      </p>
      <Link to={`/b/runs/${encodeURIComponent(partial.briefId)}`} onClick={onClose}>
        Open the {what}
      </Link>
      {error && (
        <p className="start-error" role="alert">
          {error}
        </p>
      )}
      <div className="row wrap start-actions">
        <button type="button" className="btn ghost start-cancel" onClick={onClose}>
          Close
        </button>
        <button type="button" className="btn primary" disabled={busy} onClick={onRetry}>
          {busy ? 'Creating…' : 'Create the job again'}
        </button>
      </div>
    </div>
  )
}

function CloseConfirm({
  secret,
  onKeep,
  onClose,
}: {
  secret: boolean
  onKeep: () => void
  onClose: () => void
}) {
  return (
    <div
      className="inner start-confirm"
      role="alertdialog"
      aria-label={secret ? 'Close without saving the secret?' : 'Discard this job?'}
      data-protected="block"
    >
      <b>{secret ? 'The secret is shown only once.' : 'Discard this job?'}</b>
      <span className="small muted">
        {secret
          ? 'Close without copying it? You can show it again from Settings › Tools and triggers.'
          : 'Nothing has been started yet.'}
      </span>
      <div className="row wrap">
        <button type="button" className="btn ghost" onClick={onKeep}>
          {secret ? 'Keep the secret open' : 'Keep editing'}
        </button>
        <button type="button" className="btn primary" onClick={onClose}>
          {secret ? 'Close anyway' : 'Discard'}
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
  const pairing = pairingProblem(error)
  if (pairing) return pairing
  if (error instanceof ApiError) {
    if (error.code === 'conflict') return error.message
    if (error.code === 'paused') return 'Work is paused. Resume the team or the agent first.'
    if (error.code === 'no_lead') return 'The team room has no lead yet.'
  }
  if (error instanceof Error && error.message) return error.message
  return describeCreateError(error)
}
