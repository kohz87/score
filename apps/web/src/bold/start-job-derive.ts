import { ORCH_LIMITS, suggestedCodingSteps } from '@score/contract'
import {
  deadlineIso,
  orchestrationTitleOf,
  titleOf,
  triggerNameOf,
  type StartCheck,
} from './bold-start-job.ts'
import { checksFromPreflight } from './start-job-checks.ts'
import { deriveSubagentChoice } from './start-job-subagents.ts'
import { sizeText, WHAT_CHARS } from './start-job-copy.ts'
import type { RecipeChoice, StartJobOptions } from './start-job-types.ts'
import type { StartJobData } from './use-start-job-data.ts'
import type { StartJobState } from './use-start-job-state.ts'

/** The step count a voter's answers are sized as (the old default of 20 helper steps). */
const VOTER_STEPS_SIZING = 20

export function deriveStartJobModel(
  state: StartJobState,
  data: StartJobData,
  options: StartJobOptions | undefined,
  location: { search: string },
) {
  const {
    ack,
    busy,
    cap,
    checkCommand,
    checkMinutes,
    codingSteps,
    concurrent,
    deadline,
    deadlineEnabled,
    estimate,
    inputs,
    launchesText,
    openedAt,
    quotaFloor,
    reachAcceptedKey,
    recipe,
    result,
    schedule,
    subagentsAt,
    subagentsOn,
    subagentsTotal,
    triggerApp,
    triggerName,
    when,
    what,
  } = state
  const {
    advisorId,
    agents,
    allowedFor,
    autoVoteKNumber,
    autoVoteOn,
    checkFolderNow,
    leadId,
    leadSubagents,
    orchestrationPreflight,
    roomCheck,
    voterIds,
    workflow,
    workflowDefinition,
    workflowPreflight,
  } = data

  const orchestrationWorkers = orchestrationPreflight.data?.workers ?? []
  const workflowWorkers = workflowPreflight.data?.workers ?? []
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
  const reachKey = [...reachAtStake].sort().join('|')
  const reachAccepted = reachKey !== '' && reachAcceptedKey === reachKey
  const reachCovered = reachAtStake.length === 0 || reachAccepted
  const quotaFloorValid =
    quotaFloor.trim() === '' ||
    (Number.isInteger(Number(quotaFloor)) && Number(quotaFloor) >= 0 && Number(quotaFloor) <= 50)
  const concurrentValid = textIn(concurrent, 1, 3, true)
  const estimateValid = textIn(estimate, 0.01, 1000, false)
  const codingStepsValid = textIn(codingSteps, 1, ORCH_LIMITS.maxCodingSteps, true)
  const checkMinutesNumber = Number(checkMinutes)
  const checkMinutesValid =
    Number.isInteger(checkMinutesNumber) && checkMinutesNumber >= 1 && checkMinutesNumber <= 60
  const checkOn = checkCommand.trim() !== ''
  const checkProblem = !checkOn
    ? null
    : !checkFolderNow.startsWith('/')
      ? 'The check needs an absolute folder, like /home/you/project'
      : !checkMinutesValid
        ? 'The check timeout must be 1 to 60 minutes'
        : null
  const votersOn = voterIds.length > 0
  const isCodingAgent = (id: string) => {
    const runtime = agents.find((agent) => agent.id === id)?.runtime
    return runtime !== undefined && runtime !== 'hermes'
  }
  const codingVotersNow = voterIds.some(isCodingAgent)
  const codingAdvisorNow = advisorId !== '' && isCodingAgent(advisorId)
  const launchesInUse =
    orchestrationWorkers.length > 0 ||
    allowedFor.some(isCodingAgent) ||
    codingVotersNow ||
    codingAdvisorNow
  const launchesSuggested = suggestedCodingSteps({
    codingHelpers: codingVotersNow,
    // A voter's answers are sized as the old default of 20 helper steps was; SA.3 subagents are not coding-agent launches.
    helperSteps: VOTER_STEPS_SIZING,
    codingAdvisor: codingAdvisorNow,
  })
  const launchesNow = launchesText ?? String(launchesSuggested)
  const launchesValid = textIn(launchesNow, 1, ORCH_LIMITS.maxCodingSteps, true)
  const launchesProblem =
    launchesInUse && !launchesValid
      ? `Coding-agent launches must be a whole number from 1 to ${ORCH_LIMITS.maxCodingSteps}`
      : null
  const votersProblem =
    autoVoteOn &&
    !(Number.isInteger(autoVoteKNumber) && autoVoteKNumber >= 3 && autoVoteKNumber <= 7)
      ? 'Voters per vote must be 3 to 7'
      : null
  // SA.3 subagents: the lead's settings are read first; the total must be a whole number, and counts only when on.
  const subagents = deriveSubagentChoice({
    startsNow: when === 'once',
    hasLead: leadId !== '',
    query: leadSubagents,
    on: subagentsOn,
    at: subagentsAt,
    total: subagentsTotal,
  })
  const optionProblems = optionProblemsFor(workflowWorkers.length, {
    concurrentValid,
    estimateValid,
    codingStepsValid,
    quotaFloorValid,
  })

  const nowOnce = when === 'once'
  const isLead = nowOnce && recipe.kind === 'lead'
  const isPlain = nowOnce && recipe.kind === 'none'
  const untilStopped = isLead && state.untilStoppedChoice
  const capProblem =
    untilStopped && cap <= 0
      ? 'Set a spend cap. A run that keeps going until you stop it needs one, so it can’t run up a bill.'
      : null
  const isSavedRecipe = nowOnce && recipe.kind === 'workflow'
  const showDeadline = nowOnce && !isPlain
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
      roomCheck,
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
      ...(optionProblems.length
        ? [{ key: 'options', status: 'fail' as const, text: `More options: ${optionProblems[0]}` }]
        : []),
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
      roomCheck,
      ...checksFromPreflight(
        orchestrationPreflight.isPending,
        orchestrationPreflight.isError,
        preflight?.checks,
        orchestrationPreflight.error,
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
    checks = [roomCheck, { key: 'job', status: 'ok', text: 'The job opens in the team room' }]
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
  // 3.13.2 (owner: a long prompt was cut at 4,000 characters without a word). A job the lead runs carries the text as its
  // goal, which the server takes up to 8 KB; the other paths keep 4,000 characters. Nothing is cut: Start says why.
  const whatLimit =
    isLead && !isSavedRecipe
      ? {
          size: new TextEncoder().encode(what.trim()).length,
          max: ORCH_LIMITS.goalBytes,
          unit: 'KB' as const,
        }
      : {
          // UTF-16 units, as the server's limit and the trigger's own cut count them.
          size: what.trim().length,
          max: WHAT_CHARS,
          unit: 'characters' as const,
        }
  const whatProblem =
    whatLimit.size > whatLimit.max
      ? `That’s too long (${sizeText(whatLimit.size, whatLimit.unit)} of ${sizeText(whatLimit.max, whatLimit.unit)}). Put the details in a file the agents can read, and point to it here.`
      : null
  const needsLead = isLead || when === 'schedule'
  const canStart =
    !busy &&
    !result &&
    hasWhat &&
    whatProblem === null &&
    ack &&
    checksPass &&
    reachCovered &&
    (!isSavedRecipe || optionProblems.length === 0) &&
    capProblem === null &&
    subagents.subagentsProblem === null &&
    (!isLead || (checkProblem === null && votersProblem === null && launchesProblem === null)) &&
    missingInputs.length === 0 &&
    (!needsLead || leadId !== '')

  // An archived recipe is not offered (3.8.0); a `?recipe=` link to one falls back to lead decides with a notice.
  const savedRecipes = (data.workflows.data?.items ?? []).filter((item) => !item.archivedAt)
  // `?recipe=<id>` (the Recipes page's Run) opens the dialog with that saved recipe already chosen, once.
  const wantedRecipe = new URLSearchParams(location.search).get('recipe')
  // `/run <name>` preselects by name; several or none leave "lead decides" and say so (below).
  const namedMatches = options?.recipeName
    ? savedRecipes.filter((item) => item.name.toLowerCase() === options.recipeName?.toLowerCase())
    : []
  const wantedItem = wantedRecipe
    ? savedRecipes.find((item) => item.id === wantedRecipe)
    : namedMatches.length === 1
      ? namedMatches[0]
      : undefined
  const nameNotice =
    options?.recipeName && !wantedRecipe && data.workflows.data && namedMatches.length !== 1
      ? namedMatches.length > 1
        ? `More than one recipe is called “${options.recipeName}”. Pick one below.`
        : `No saved recipe is called “${options.recipeName}”. Pick one below.`
      : null
  const wantedArchived =
    wantedRecipe !== null &&
    (data.workflows.data?.items ?? []).some((item) => item.id === wantedRecipe && item.archivedAt)
  const recipeOptions: { key: string; label: string; choice: RecipeChoice }[] = [
    { key: 'lead', label: 'lead decides', choice: { kind: 'lead' } },
    { key: 'none', label: 'None', choice: { kind: 'none' } },
    ...savedRecipes.map((item) => ({
      key: `workflow:${item.id}`,
      label: item.name,
      choice: { kind: 'workflow' as const, id: item.id, name: item.name },
    })),
  ]

  return {
    orchestrationWorkers,
    orchestrationReach: orchestrationWorkers.flatMap((worker) =>
      worker.reachBeyondWorkspace && worker.policyId ? [worker.policyId] : [],
    ),
    workflowWorkers,
    workflowReach: workflowWorkers.flatMap((worker) =>
      worker.reachBeyondWorkspace && worker.policyId ? [worker.policyId] : [],
    ),
    workersAtStake,
    reachAtStake,
    reachKey,
    reachAccepted,
    reachCovered,
    quotaFloorValid,
    concurrentValid,
    estimateValid,
    codingStepsValid,
    checkMinutesNumber,
    checkMinutesValid,
    checkOn,
    checkProblem,
    launchesInUse,
    launchesNow,
    launchesValid,
    launchesProblem,
    votersOn,
    votersProblem,
    subagentsOn,
    subagentsTotal,
    ...subagents,
    optionProblems,
    nowOnce,
    isLead,
    isPlain,
    untilStopped,
    capProblem,
    isSavedRecipe,
    showWhat: !isSavedRecipe,
    showRecipe: nowOnce,
    showAsk: nowOnce && !isPlain,
    showDeadline,
    showUnknownCost: nowOnce && isSavedRecipe,
    showSaveRecipe: nowOnce && !isSavedRecipe,
    jobTitle,
    saveName,
    deadlineAt,
    deadlinePast,
    missingInputs,
    checks,
    checksPass,
    hasWhat,
    whatLimit,
    whatProblem,
    needsLead,
    canStart,
    savedRecipes,
    wantedItem,
    wantedArchived,
    nameNotice,
    recipeOptions,
  }
}

function textIn(text: string | null, min: number, max: number, whole: boolean) {
  return (
    text === null ||
    (text.trim() !== '' &&
      Number.isFinite(Number(text)) &&
      Number(text) >= min &&
      Number(text) <= max &&
      (!whole || Number.isInteger(Number(text))))
  )
}

function optionProblemsFor(
  workflowWorkerCount: number,
  valid: {
    concurrentValid: boolean
    estimateValid: boolean
    codingStepsValid: boolean
    quotaFloorValid: boolean
  },
) {
  return [
    ...(valid.concurrentValid ? [] : ['Steps at the same time must be 1 to 3']),
    ...(valid.estimateValid ? [] : ['Estimate per step must be above 0 and at most 1000']),
    ...(workflowWorkerCount > 0 && !valid.codingStepsValid
      ? [`Most coding steps must be 1 to ${ORCH_LIMITS.maxCodingSteps}`]
      : []),
    ...(workflowWorkerCount > 0 && !valid.quotaFloorValid
      ? ['Quota floor must be a whole number from 0 to 50, or blank']
      : []),
  ]
}
