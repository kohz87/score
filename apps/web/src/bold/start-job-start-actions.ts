import {
  JobSchema,
  ORCH_ACKNOWLEDGEMENT_TEXT,
  ORCH_DEFAULTS,
  OrchestrationCreatedSchema,
  RoutineSummarySchema,
  TriggerCreatedSchema,
  WorkflowRunCreatedSchema,
  WorkflowVersionSchema,
  type OrchestrationCheck,
  type RunTopicRequest,
  type WorkflowRunCreate,
} from '@score/contract'
import { useQueryClient } from '@tanstack/react-query'
import type { FormEvent, MutableRefObject } from 'react'
import { apiFetch, ApiError } from '../data/api.ts'
import type { OrchestrationCreateBody } from '../routes/orchestrations/orchestration-queries.ts'
import { routinesKey } from '../routes/team/routine-queries.ts'
import { jobRunningOf } from './room/BusyDialog.tsx'
import {
  oneStepRecipe,
  orchestrationPolicy,
  orchestrationTitleOf,
  scheduleValue,
  triggerRequest,
  workflowPolicy,
} from './bold-start-job.ts'
import { authProblem, startError } from './start-job-copy.ts'
import type { StartJobFormActions } from './start-job-form-actions.ts'
import type { StartJobModel } from './start-job-model.ts'
import type { JobLimits } from './start-job-types.ts'
import type { StartJobData } from './use-start-job-data.ts'
import type { StartJobState } from './use-start-job-state.ts'

export function useStartJobStartActions(
  state: StartJobState,
  data: StartJobData,
  model: StartJobModel,
  form: StartJobFormActions,
  attemptKeyRef: MutableRefObject<string | null>,
  stoppedForStartRef: MutableRefObject<string | null>,
  startingRef: MutableRefObject<boolean>,
  savedRecipeNameRef: MutableRefObject<string | null>,
) {
  const queryClient = useQueryClient()

  function jobLimits(): JobLimits {
    if (!model.nowOnce || model.isSavedRecipe) return {}
    return {
      exchangeBudget: state.turns,
      jobTurnLimit: JOB_TURN_LIMIT,
      ...(state.cap > 0 ? { spendCapUsd: state.cap } : {}),
    }
  }

  /** The topic a run makes in the chat, in the run's own request: its title and the limits a plain job takes. */
  function runTopic(title: string): RunTopicRequest {
    if (!data.startRoom) throw new Error(data.roomProblem)
    return { roomId: data.startRoom.id, title, ...jobLimits() }
  }

  async function createJob(title: string, limits: JobLimits) {
    if (!data.startRoom) throw new Error(data.roomProblem)
    return JobSchema.parse(
      await form.attemptPost(`rooms/${encodeURIComponent(data.startRoom.id)}/jobs`, {
        title,
        ...limits,
      }),
    )
  }

  async function startOrchestration(topic: RunTopicRequest) {
    const preflight = data.orchestrationPreflight.data
    if (!preflight) throw new Error('The checks are not ready yet.')
    const codingPolicies = Object.fromEntries(
      model.orchestrationWorkers.flatMap((worker) =>
        worker.policyId ? [[worker.agentId, worker.policyId] as const] : [],
      ),
    )
    const body: OrchestrationCreateBody = {
      title: orchestrationTitleOf(state.what),
      topic,
      goal: state.what.trim(),
      leadAgentId: data.leadId,
      allowedAgents: data.allowedFor,
      ...(data.advisorId !== '' ? { advisorAgentId: data.advisorId } : {}),
      ...(model.helpersOn
        ? {
            helpers: {
              agentIds: data.helperIds,
              maxConcurrent: data.helperConcurrentNumber,
              maxSteps: state.helperNoLimit ? null : data.helperStepsNumber,
              autoVote: data.autoVoteOn,
              autoVoteK: data.autoVoteOn ? data.autoVoteKNumber : 3,
              autoAudit: state.autoAudit,
              scan: state.helperScan,
              ...(state.helperScan ? { scanFolder: data.helperFolderNow.trim() } : {}),
              splitTo: state.helperSplit,
              ...(data.voterIds.length > 0 ? { voterIds: data.voterIds } : {}),
            },
          }
        : {}),
      gatePolicy: orchestrationPolicy(state.ask),
      ...(state.cap > 0 ? { budgetUsd: state.cap } : {}),
      ...(model.deadlineAt ? { deadlineAt: model.deadlineAt } : {}),
      maxSteps: ORCH_DEFAULTS.maxSteps,
      maxLeadTurns: state.turns,
      ...(model.untilStopped ? { untilStopped: true } : {}),
      maxConcurrentSteps: ORCH_DEFAULTS.maxConcurrentSteps,
      leadTurnEstimateUsd: ORCH_DEFAULTS.leadTurnEstimateUsd,
      stepEstimateUsd: ORCH_DEFAULTS.stepEstimateUsd,
      acknowledgement: { text: ORCH_ACKNOWLEDGEMENT_TEXT },
      ...(model.checkOn
        ? {
            check: {
              command: state.checkCommand.trim(),
              workspace: data.checkFolderNow.trim(),
              timeoutSec: model.checkMinutesNumber * 60,
              when: state.checkEachStep ? 'each_step' : 'finish',
            } satisfies OrchestrationCheck,
          }
        : {}),
      ...(model.launchesInUse ? { codingSteps: Number(model.launchesNow) } : {}),
      ...(model.orchestrationWorkers.length > 0
        ? {
            codingPolicies,
            ...(model.orchestrationReach.length > 0
              ? { acknowledgeCodingReach: { policyIds: model.orchestrationReach } }
              : {}),
          }
        : {}),
    }
    return OrchestrationCreatedSchema.parse(await form.attemptPost('orchestrations', body))
  }

  async function startWorkflow(topic: RunTopicRequest) {
    if (state.recipe.kind !== 'workflow') throw new Error('The recipe is not ready yet.')
    if (
      !data.workflowDefinition ||
      data.workflowVersion === undefined ||
      !data.workflowPreflight.data
    )
      throw new Error('The recipe is not ready yet.')
    const preflight = data.workflowPreflight.data
    const codingPolicies = Object.fromEntries(
      model.workflowWorkers.flatMap((worker) =>
        worker.policyId ? [[worker.agentId, worker.policyId] as const] : [],
      ),
    )
    const body: WorkflowRunCreate = {
      workflowId: state.recipe.id,
      version: data.workflowVersion,
      topic,
      inputs: Object.fromEntries(
        data.workflowDefinition.inputs.flatMap((input) => {
          const value = (state.inputs[input.name] ?? '').trim()
          return value ? [[input.name, value] as const] : []
        }),
      ),
      agentMap: preflight.mapping.map(({ agentId, incarnation }) => ({ agentId, incarnation })),
      gatePolicy: workflowPolicy(state.ask),
      ...(state.cap > 0 ? { budgetUsd: state.cap } : {}),
      ...(model.deadlineAt ? { deadlineAt: model.deadlineAt } : {}),
      unknownSpend: state.unknownSpend,
      maxConcurrentSteps:
        state.concurrent === null
          ? preflight.defaults.maxConcurrentSteps
          : Number(state.concurrent),
      stepEstimateUsd:
        state.estimate === null ? preflight.defaults.stepEstimateUsd : Number(state.estimate),
      acknowledgement: { text: ORCH_ACKNOWLEDGEMENT_TEXT },
      ...(model.workflowWorkers.length > 0
        ? {
            codingPolicies,
            codingSteps:
              state.codingSteps === null
                ? (preflight.defaults.codingSteps ?? 1)
                : Number(state.codingSteps),
            ...(state.quotaFloor.trim() !== '' && model.quotaFloorValid
              ? { quotaFloorPercent: Number(state.quotaFloor) }
              : {}),
            ...(model.workflowReach.length > 0
              ? { acknowledgeCodingReach: { policyIds: model.workflowReach } }
              : {}),
            ...(state.unknownSpend === 'pause' && state.unknownCost.length > 0
              ? { acceptUnknownCost: state.unknownCost }
              : {}),
          }
        : {}),
    }
    return WorkflowRunCreatedSchema.parse(await form.attemptPost('workflow-runs', body))
  }

  /** Saving a recipe happens after the work exists: a failed start must not leave a recipe behind. */
  async function saveRecipeAfterStart() {
    if (!state.saveRecipe || !model.showSaveRecipe || !data.leadId) return
    if (savedRecipeNameRef.current === model.saveName) return
    savedRecipeNameRef.current = model.saveName
    try {
      await form
        .attemptPost('workflows', {
          definition: oneStepRecipe({
            name: model.saveName,
            instruction: state.what,
            agentId: data.leadId,
          }),
        })
        .then((body) => WorkflowVersionSchema.parse(body))
      await queryClient.invalidateQueries({ queryKey: ['workflows'] })
      if (model.savedRecipes.some((item) => item.name === model.saveName))
        state.setSaveWarning(
          `Saved “${model.saveName}” again; a recipe with that name already existed.`,
        )
    } catch (failure) {
      state.setSaveWarning(`It started, but saving the recipe failed: ${startError(failure)}`)
    }
  }

  /** One job per chat (3.28.0): the busy dialog names the running job and what was being started. */
  function askBusy(running: { id: string; title: string }, note?: string) {
    state.setBusyStart({
      running,
      chatName: data.startRoom?.name ?? 'This chat',
      starting:
        model.isSavedRecipe && model.nowOnce
          ? `${model.jobTitle} · run “${state.recipe.kind === 'workflow' ? state.recipe.name : ''}”`
          : model.jobTitle,
      ...(note ? { note } : {}),
    })
  }

  async function start(proved = false) {
    if (!model.canStart || startingRef.current) return
    // A start into a chat that already has a job asks first. After "Stop the job and start this" the read of the room
    // may not have caught up yet, so the job just stopped isn't asked about again: the server answers 409 while it is
    // still stopping. The stop never stands in for the password step below (3.28.0 review).
    if (
      model.nowOnce &&
      data.startRoom &&
      data.runningJob &&
      data.runningJob.id !== stoppedForStartRef.current
    ) {
      attemptKeyRef.current = null
      askBusy(data.runningJob)
      return
    }
    // 3.13: a check runs a command as this user, so starting needs the password or passkey first.
    if (model.isLead && model.checkOn && !proved) {
      state.setAuthError(null)
      state.setAuthNeeded(true)
      return
    }
    startingRef.current = true
    state.setBusy(true)
    state.setError(null)
    state.setSaveWarning(null)
    try {
      const title = model.jobTitle
      if (state.when === 'webhook') {
        const made = TriggerCreatedSchema.parse(
          await form.attemptPost(
            'triggers',
            triggerRequest({ name: state.triggerName, app: state.triggerApp, what: state.what }),
          ),
        )
        state.setResult({
          kind: 'trigger',
          title: made.trigger.name,
          url: made.trigger.url,
          secret: made.secret,
        })
        return
      }

      if (state.when === 'schedule') {
        const made = RoutineSummarySchema.parse(
          await form.attemptPost(`agents/${encodeURIComponent(data.leadId)}/routines`, {
            title,
            schedule: scheduleValue(state.schedule),
            prompt: state.what.trim(),
          }),
        )
        await queryClient.invalidateQueries({ queryKey: routinesKey(data.leadId), exact: true })
        state.setResult({ kind: 'routine', title: made.title, schedule: state.schedule })
        return
      }

      if (model.isSavedRecipe) {
        // 3.23.0: the run and its topic in the chat are made by one call, so there is no half-made state to repair.
        const made = await startWorkflow(runTopic(title))
        state.setResult({
          kind: 'workflow',
          title: made.run.title,
          runId: made.run.id,
          jobId: made.topicId,
        })
      } else if (model.isLead) {
        const made = await startOrchestration(runTopic(title))
        if (!made.topicId)
          throw new Error('The run started but Score didn’t get its topic; open it from Recipes.')
        state.setResult({
          kind: 'job',
          title,
          jobId: made.topicId,
          orchestrationId: made.orchestration.id,
        })
      } else {
        const job = await createJob(title, jobLimits())
        state.setResult({ kind: 'job', title, jobId: job.id })
      }
      await saveRecipeAfterStart()
    } catch (failure) {
      const running = jobRunningOf(failure)
      if (running) {
        // The server's answer is not replayed for a new try: the next start is a new attempt.
        attemptKeyRef.current = null
        askBusy(
          running,
          running.id === stoppedForStartRef.current
            ? 'Still stopping… try again in a moment.'
            : undefined,
        )
        return
      }
      if (failure instanceof ApiError && failure.code === 'fresh_auth_required') {
        state.setAuthError(startError(failure))
        state.setAuthNeeded(true)
        return
      }
      // A coding agent changed meanwhile: look again, and ask again where the reach changed.
      if (failure instanceof ApiError && ['policy_changed', 'conflict'].includes(failure.code)) {
        attemptKeyRef.current = null
        void data.workflowPreflight.refetch()
        void data.orchestrationPreflight.refetch()
      }
      state.setError(startError(failure))
    } finally {
      startingRef.current = false
      state.setBusy(false)
    }
  }

  async function confirmThenStart(proof: () => Promise<unknown>) {
    if (state.authBusy) return
    state.setAuthBusy(true)
    state.setAuthError(null)
    try {
      await proof()
    } catch (failure) {
      state.setAuthError(authProblem(failure))
      state.setAuthBusy(false)
      return
    }
    state.setAuthPassword('')
    state.setAuthNeeded(false)
    state.setAuthBusy(false)
    await start(true)
  }

  function submitAuth(event: FormEvent) {
    event.preventDefault()
    void confirmThenStart(() =>
      apiFetch('session/security/check', {
        method: 'POST',
        body: JSON.stringify({ password: state.authPassword }),
      }),
    )
  }

  return { start, confirmThenStart, submitAuth }
}

const JOB_TURN_LIMIT = 40
