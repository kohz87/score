import {
  type AgentSummary,
  ORCH_CAPACITY,
  type WorkflowRunCreate,
  type WorkflowRunCreated,
} from '@score/contract'
import { randomUUID } from 'node:crypto'
import { HttpError } from '../../errors.ts'
import { lifecycleOf } from '../agent-lifecycle.ts'
import { isFenced } from './fence.ts'
import { codingItemsFor, codingUnsentBytes } from './ops.ts'
import { readVersion } from '../workflows/definitions.ts'
import {
  insertWorkflowRun,
  stepBudgetOf,
  validateInputs,
  workflowReserve,
} from '../workflows/runs.ts'

import type { OrchestratorRuntime } from './executor-runtime.ts'
import { capacityUsed, quotaUsed } from './executor-capacity.ts'

export const workflowCreateMethods = {
  async createWorkflowRun(
    this: OrchestratorRuntime,
    body: WorkflowRunCreate,
    agents?: Pick<AgentSummary, 'id' | 'served' | 'runtime'>[],
  ): Promise<WorkflowRunCreated> {
    const found = this.db.read((sqlite) => readVersion(sqlite, body.workflowId, body.version))
    validateInputs(found, body.inputs)
    // A definition the team or the host can't run (7.7c §1) gets the same answer as at save: structured issues.
    const validation = await this.validateWorkflow(found.definition, agents)
    if (!validation.ok)
      throw new HttpError(
        422,
        'invalid_definition',
        'This workflow can’t start as it is. Fix the problems and save a new version.',
        { result: validation },
      )
    const { preflight, reports } = await this.workflowPreflightWith(
      body.workflowId,
      body.version,
      agents,
      body.maxConcurrentSteps,
    )
    // A workflow with no coding step node sends and stores no coding fields at all (7.7c §1).
    if (
      reports.size === 0 &&
      (body.codingPolicies !== undefined ||
        body.acknowledgeCodingReach !== undefined ||
        body.acceptUnknownCost !== undefined ||
        body.codingSteps !== undefined ||
        body.quotaFloorPercent !== undefined)
    )
      throw new HttpError(
        400,
        'bad_request',
        'This workflow has no coding agents, so it takes no coding settings.',
      )
    if (!preflight.ok) {
      const failed = (id: string) =>
        preflight.checks.some((check) => check.id === id && check.status === 'fail')
      const details = { checks: preflight.checks }
      if (failed('global_fence'))
        throw new HttpError(
          409,
          'fenced',
          'New runs can’t start until you review the runs that need checking on Now.',
          details,
        )
      if (failed('capacity'))
        throw new HttpError(429, 'capacity', 'Too many runs are using capacity.', details)
      if (failed('quota'))
        throw new HttpError(409, 'quota_exhausted', 'Score has no storage left for runs.', details)
      throw new HttpError(409, 'preflight_failed', 'The check before the run failed.', details)
    }
    // Consent is by policy id (7.7b §4, 7.7c §2): the id the person saw must still be the agent's, and a reach beyond the
    // workspace needs the acknowledgement of exactly that id. A rerun asks again; nothing carries over from the earlier run.
    for (const agentId of Object.keys(body.codingPolicies ?? {}))
      if (!reports.has(agentId))
        throw new HttpError(
          400,
          'bad_request',
          `${agentId} is not a coding agent of this workflow.`,
        )
    for (const [agentId, report] of reports) {
      const seen = body.codingPolicies?.[agentId]
      if (seen === undefined)
        throw new HttpError(
          400,
          'bad_request',
          `The request has to name the settings it was approved with for ${agentId}.`,
        )
      if (seen !== report.policyId)
        throw new HttpError(
          409,
          'policy_changed',
          `${agentId} changed since you looked. Check what it can reach and start again.`,
          { agentId, currentPolicyId: report.policyId },
        )
      if (
        report.reachBeyondWorkspace &&
        !body.acknowledgeCodingReach?.policyIds.includes(report.policyId!)
      )
        throw new HttpError(
          409,
          'reach_not_acknowledged',
          `${agentId} can read beyond its workspace. Accept that before the run starts.`,
          { agentId, policyId: report.policyId },
        )
    }
    const coding =
      reports.size > 0
        ? {
            reports,
            codingSteps: body.codingSteps ?? preflight.defaults.codingSteps ?? 1,
          }
        : undefined
    const id = `orc-${randomUUID().slice(0, 8)}`
    let topicId: string | undefined
    await this.mutate((ctx) => {
      const { sqlite, now } = ctx
      if (isFenced(sqlite))
        throw new HttpError(
          409,
          'fenced',
          'New runs can’t start until you review the runs that need checking on Now.',
        )
      if (capacityUsed(sqlite) >= ORCH_CAPACITY.runningOrchestrations)
        throw new HttpError(429, 'capacity', 'Too many runs are using capacity.')
      const steps = stepBudgetOf(found)
      const reserve = workflowReserve(
        steps,
        coding === undefined ? 0 : codingItemsFor(steps, coding.codingSteps),
        coding === undefined ? 0 : codingUnsentBytes(steps, body.maxConcurrentSteps),
      )
      if (quotaUsed(sqlite) + reserve > this.quotaBytes)
        throw new HttpError(409, 'quota_exhausted', 'Score has no storage left for this run.')
      if (body.deadlineAt !== undefined && body.deadlineAt <= now)
        throw new HttpError(400, 'bad_request', 'The deadline must be in the future.')
      // The person must have seen the incarnations the run will be bound to.
      const shown = new Map(body.agentMap.map((entry) => [entry.agentId, entry.incarnation]))
      for (const entry of preflight.mapping) {
        const current = lifecycleOf(sqlite, entry.agentId)?.incarnation_id ?? 'untracked'
        if (shown.get(entry.agentId) !== current || shown.size !== preflight.mapping.length)
          throw new HttpError(
            409,
            'conflict',
            `${entry.agentId} changed. Look at the start screen again.`,
          )
      }
      insertWorkflowRun(ctx, id, body, found, preflight, coding)
      // 3.23.0: the chat topic is made in this transaction, so a failure leaves neither the run nor the topic.
      if (body.topic) topicId = this.insertTopic(ctx, body.topic, 'workflow', id)
    })
    this.kick()
    return {
      run: this.workflowSummary(id),
      preflight,
      ...(topicId !== undefined ? { topicId } : {}),
    }
  },
}

export type WorkflowCreateMethods = typeof workflowCreateMethods

export type WorkflowCreatePublicMethods = Pick<WorkflowCreateMethods, 'createWorkflowRun'>
