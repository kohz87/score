import {
  type AgentSummary,
  type RunTopicRequest,
  ORCH_LIMITS,
  type OrchestrationCreate,
  type OrchestrationCreated,
  HELPER_STEPS_UNLIMITED_SIZING,
  suggestedCodingSteps,
} from '@score/contract'
import { randomUUID } from 'node:crypto'
import { HttpError } from '../../errors.ts'
import { lifecycleOf } from '../agent-lifecycle.ts'
import { createJob } from '../exchanges/store.ts'
import { type Ctx } from './ctx.ts'
import { type HelpersConfig, startScan } from './helpers.ts'
import { splitCommand } from './check-command.ts'
import { type CheckConfig, shownCommand } from './checks.ts'
import { ADVISOR_STEPS } from './advisor.ts'
import { addHistory, readOrch } from './store.ts'

import type { OrchestratorRuntime } from './executor-runtime.ts'

/** Every step a run may hold: the lead's, its helpers' and the advisor's consults (3.14–3.16). */
export const effectiveSteps = (body: OrchestrationCreate): number =>
  body.maxSteps +
  (body.helpers ? (body.helpers.maxSteps ?? HELPER_STEPS_UNLIMITED_SIZING) : 0) +
  (body.advisorAgentId !== undefined ? ADVISOR_STEPS : 0)

export const createMethods = {
  async create(
    this: OrchestratorRuntime,
    body: OrchestrationCreate,
    agents?: Pick<AgentSummary, 'id' | 'served' | 'runtime'>[],
  ): Promise<OrchestrationCreated> {
    // 3.13.1: without a launch limit, one is sized for coding helpers, voters and advisor (each consult is a launch).
    if (body.codingSteps === undefined && (body.helpers || body.advisorAgentId !== undefined)) {
      const coding = (id: string) =>
        (agents ?? []).some((a) => a.id === id && a.runtime && a.runtime !== 'hermes')
      body = {
        ...body,
        codingSteps: suggestedCodingSteps({
          codingHelpers: [
            ...(body.helpers?.agentIds ?? []),
            ...(body.helpers?.voterIds ?? []),
          ].some(coding),
          helperSteps: body.helpers ? body.helpers.maxSteps : 0,
          codingAdvisor: body.advisorAgentId !== undefined && coding(body.advisorAgentId),
        }),
      }
    }
    // 3.27.0: a run that goes on until the person stops it keeps the largest caps only to size its storage reserve; the
    // checks skip them (until_stopped), and its spend cap is required (the contract refuses one without).
    if (body.untilStopped) {
      if (body.budgetUsd === undefined)
        throw new HttpError(
          400,
          'bad_request',
          'A run that goes on until you stop it needs a spend cap.',
        )
      body = { ...body, maxSteps: ORCH_LIMITS.maxSteps, maxLeadTurns: ORCH_LIMITS.maxLeadTurns }
    }
    // 3.14–3.15: the advisor and helpers are checked (served, coding consent) like the agents the lead may assign to.
    const advisor = body.advisorAgentId
    if (advisor !== undefined && advisor === body.leadAgentId)
      throw new HttpError(400, 'bad_request', 'The advisor has to be another agent than the lead.')
    const helpers = body.helpers
    if (helpers) {
      if (helpers.agentIds.includes(body.leadAgentId))
        throw new HttpError(400, 'bad_request', 'The lead can’t be one of its own helpers.')
      if (new Set(helpers.agentIds).size !== helpers.agentIds.length)
        throw new HttpError(400, 'bad_request', 'A helper is listed twice.')
      const voters = helpers.voterIds ?? []
      if (voters.includes(body.leadAgentId))
        throw new HttpError(400, 'bad_request', 'The lead can’t vote on its own questions.')
      if (new Set(voters).size !== voters.length)
        throw new HttpError(400, 'bad_request', 'A voter is listed twice.')
      if (helpers.scan && !helpers.scanFolder && !body.check)
        throw new HttpError(400, 'bad_request', 'Say which folder the helpers should scan.')
    }
    const extra = [
      ...new Set([
        ...(advisor !== undefined ? [advisor] : []),
        ...(helpers?.agentIds ?? []),
        ...(helpers?.voterIds ?? []),
      ]),
    ].filter((agent) => !body.allowedAgents.includes(agent))
    const { preflight, reports } = await this.preflightWith(
      body.leadAgentId,
      [...body.allowedAgents, ...extra],
      agents,
      body.maxConcurrentSteps,
    )
    if (new Set(body.allowedAgents).size !== body.allowedAgents.length)
      throw new HttpError(400, 'bad_request', 'An agent is listed twice in the allowed agents.')
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
        throw new HttpError(429, 'capacity', 'Too many orchestrations are running.', details)
      if (failed('quota'))
        throw new HttpError(
          409,
          'quota_exhausted',
          'Score has no storage left for orchestrations.',
          details,
        )
      throw new HttpError(409, 'preflight_failed', 'The check before the run failed.', details)
    }
    // Consent is by policy id (7.7b §4): the id the person saw must still be the agent's, and a reach beyond the workspace
    // needs the acknowledgement of exactly that id.
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
    let check: CheckConfig | null = null
    if (body.check) {
      const split = splitCommand(body.check.command)
      if (!split.ok) throw new HttpError(400, 'invalid_check', split.reason)
      check = {
        argv: split.argv,
        workspace: body.check.workspace,
        timeoutSec: body.check.timeoutSec,
        when: body.check.when,
      }
    }
    const id = `orc-${randomUUID().slice(0, 8)}`
    let topicId: string | undefined
    await this.mutate((ctx) => {
      this.insert(ctx, id, body, preflight, reports)
      if (body.untilStopped)
        ctx.sqlite.prepare('UPDATE orchestrations SET until_stopped = 1 WHERE id = ?').run(id)
      // 3.23.0: the chat topic is made in this transaction, so a failure leaves neither the run nor the topic.
      if (body.topic) topicId = this.insertTopic(ctx, body.topic, 'orchestration', id)
      if (helpers) {
        const config: HelpersConfig = {
          agentIds: helpers.agentIds,
          maxConcurrent: helpers.maxConcurrent,
          maxSteps: helpers.maxSteps,
          scan: helpers.scan,
          scanFolder: helpers.scanFolder ?? (helpers.scan ? (body.check?.workspace ?? null) : null),
          splitTo: helpers.splitTo,
          voterIds: helpers.voterIds ?? [],
          // Score's own votes are made without the person: never under every-step approval.
          autoVote: helpers.autoVote && body.gatePolicy !== 'every-step',
          autoVoteK: helpers.autoVoteK,
          autoAudit: helpers.autoAudit,
        }
        ctx.sqlite
          .prepare('UPDATE orchestrations SET helpers_json = ? WHERE id = ?')
          .run(JSON.stringify(config), id)
        const freeze = ctx.sqlite.prepare(
          `INSERT OR IGNORE INTO orc_agent_map (orchestration_id, agent_id, role, incarnation, updated_at) VALUES (?, ?, 'agent', ?, ?)`,
        )
        for (const agent of new Set([...helpers.agentIds, ...(helpers.voterIds ?? [])]))
          freeze.run(
            id,
            agent,
            lifecycleOf(ctx.sqlite, agent)?.incarnation_id ?? 'untracked',
            ctx.now,
          )
        addHistory(ctx.sqlite, id, 'helpers_set', { ...config }, ctx.now)
        if (config.scan && config.scanFolder)
          startScan(ctx, readOrch(ctx.sqlite, id)!, config.scanFolder)
      }
      if (advisor !== undefined) {
        ctx.sqlite
          .prepare('UPDATE orchestrations SET advisor_agent_id = ?, advisor_mode = ? WHERE id = ?')
          .run(advisor, body.advisorMode ?? 'checkpoints', id)
        // Frozen like every agent the run was started with, so a replaced advisor waits for the person's remap.
        ctx.sqlite
          .prepare(
            `INSERT OR IGNORE INTO orc_agent_map (orchestration_id, agent_id, role, incarnation, updated_at) VALUES (?, ?, 'agent', ?, ?)`,
          )
          .run(
            id,
            advisor,
            lifecycleOf(ctx.sqlite, advisor)?.incarnation_id ?? 'untracked',
            ctx.now,
          )
        addHistory(ctx.sqlite, id, 'advisor_set', { agentId: advisor }, ctx.now)
      }
      if (check) {
        ctx.sqlite
          .prepare('UPDATE orchestrations SET check_json = ? WHERE id = ?')
          .run(JSON.stringify(check), id)
        addHistory(
          ctx.sqlite,
          id,
          'check_set',
          { command: shownCommand(check.argv), workspace: check.workspace },
          ctx.now,
        )
      }
    })
    this.kick()
    return {
      orchestration: this.summary(id),
      preflight,
      ...(topicId !== undefined ? { topicId } : {}),
    }
  },

  /** 3.23.0: a run's topic in the chat it was started from, linked to the run (the chat's run card reads the link). */
  insertTopic(
    this: OrchestratorRuntime,
    ctx: Ctx,
    topic: RunTopicRequest,
    kind: 'orchestration' | 'workflow',
    ref: string,
  ): string {
    const { roomId, title, ...limits } = topic
    const made = createJob(ctx.sqlite, roomId, title, ctx.now, { ...limits, recipe: { kind, ref } })
    ctx.events.push(...made.drafts)
    return made.job.id
  },
}

export type CreateMethods = typeof createMethods

export type CreatePublicMethods = Pick<CreateMethods, 'create'>
