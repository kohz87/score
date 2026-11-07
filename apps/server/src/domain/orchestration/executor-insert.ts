import {
  ORCH_ACKNOWLEDGEMENT_TEXT,
  ORCH_CAPACITY,
  ORCH_DEFAULTS,
  type OrchestrationCreate,
  type Preflight,
} from '@score/contract'
import { HttpError } from '../../errors.ts'
import { lifecycleOf } from '../agent-lifecycle.ts'
import { briefTitle, createBrief, emitBriefChange } from '../briefs.ts'
import { insertRoom, storeMessage } from '../rooms.ts'
import { journalSoft, touch, type Ctx } from './ctx.ts'
import { isFenced } from './fence.ts'
import { storeWorkerPolicy } from './coding-policy.ts'
import { reserveFor, CODING_ITEM_EXTRA_BYTES, codingItemsFor, codingUnsentBytes } from './ops.ts'
import { type WorkerReport } from './supported-agents.ts'
import { CHECK_RESERVE_BYTES } from './checks.ts'
import { addCause, addHistory } from './store.ts'

import type { OrchestratorRuntime } from './executor-runtime.ts'
import { capacityUsed, quotaUsed } from './executor-capacity.ts'
import { effectiveSteps } from './executor-create.ts'

export const insertMethods = {
  insert(
    this: OrchestratorRuntime,
    ctx: Ctx,
    id: string,
    body: OrchestrationCreate,
    preflight: Preflight,
    reports: Map<string, WorkerReport>,
  ): void {
    const { sqlite, now } = ctx
    if (isFenced(sqlite))
      throw new HttpError(
        409,
        'fenced',
        'New runs can’t start until you review the runs that need checking on Now.',
      )
    const live = capacityUsed(sqlite)
    if (live >= ORCH_CAPACITY.runningOrchestrations)
      throw new HttpError(
        429,
        'capacity',
        `${ORCH_CAPACITY.runningOrchestrations} orchestrations are already running.`,
      )
    // 3.14–3.16 (review): helper work and consults are steps too; the storage and coding reserves are sized for them.
    const steps = effectiveSteps(body)
    const concurrent = body.maxConcurrentSteps + (body.helpers?.maxConcurrent ?? 0)
    const reserve =
      reserveFor(
        steps,
        body.maxLeadTurns,
        reports.size > 0 ? codingItemsFor(steps, body.codingSteps ?? ORCH_DEFAULTS.codingSteps) : 0,
        reports.size > 0 ? codingUnsentBytes(steps, concurrent) : 0,
      ) + (body.check ? CHECK_RESERVE_BYTES : 0)
    if (quotaUsed(sqlite) + reserve > this.quotaBytes)
      throw new HttpError(
        409,
        'quota_exhausted',
        'Score has no storage left for this orchestration.',
      )
    if (body.deadlineAt !== undefined && body.deadlineAt <= now)
      throw new HttpError(400, 'bad_request', 'The deadline must be in the future.')
    const title = body.title ?? briefTitle(body.goal)
    const roomId = `room-${id}`
    const messageId = `orc-goal:${id}`
    const lifecycle = lifecycleOf(sqlite, body.leadAgentId)
    insertRoom(
      sqlite,
      {
        id: roomId,
        name: `Orchestration: ${title.slice(0, 80)} (${id.slice(4)})`,
        kind: 'room',
        leadAgentId: body.leadAgentId,
        members: [body.leadAgentId, ...body.allowedAgents],
        // The executor routes this room itself (PLAN 11.11 moves only the rooms people talk in).
        routing: 'mentions',
      },
      now,
    )
    ctx.events.push(
      ...storeMessage(
        sqlite,
        {
          id: messageId,
          roomId,
          author: { kind: 'you' },
          to: [],
          parts: [{ kind: 'text', text: body.goal }],
          createdAt: now,
          streaming: false,
          refs: [],
        },
        now,
      ),
    )
    // The brief's event is dropped: its first status is the run's, emitted when the run is touched below.
    createBrief(sqlite, { id: messageId, roomId, text: body.goal }, now)
    sqlite
      .prepare(
        `INSERT INTO orchestrations (id, title, goal, lead_agent_id, lead_incarnation, allowed_agents, room_id, brief_id, gate_policy,
           budget_usd, deadline_at, max_steps, max_lead_turns, max_concurrent_steps, lead_turn_estimate_usd, step_estimate_usd,
           status, acknowledgement, preflight, reserve_bytes, stored_bytes, created_at, updated_at, coding_steps, accepted_unknown_cost,
           coding_reserve_bytes)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'running', ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        id,
        title,
        body.goal,
        body.leadAgentId,
        lifecycle?.incarnation_id ?? 'untracked',
        JSON.stringify(body.allowedAgents),
        roomId,
        messageId,
        body.gatePolicy,
        body.budgetUsd ?? null,
        body.deadlineAt ?? null,
        body.maxSteps,
        body.maxLeadTurns,
        body.maxConcurrentSteps,
        body.leadTurnEstimateUsd,
        body.stepEstimateUsd,
        JSON.stringify({ text: ORCH_ACKNOWLEDGEMENT_TEXT, at: now }),
        JSON.stringify(preflight),
        reserve,
        Buffer.byteLength(body.goal) + 1024,
        now,
        now,
        body.codingSteps ?? ORCH_DEFAULTS.codingSteps,
        JSON.stringify([...new Set(body.acceptUnknownCost ?? [])].sort()),
        reports.size > 0
          ? codingItemsFor(effectiveSteps(body), body.codingSteps ?? ORCH_DEFAULTS.codingSteps) *
              CODING_ITEM_EXTRA_BYTES +
              codingUnsentBytes(
                effectiveSteps(body),
                body.maxConcurrentSteps + (body.helpers?.maxConcurrent ?? 0),
              )
          : 0,
      )
    if (body.quotaFloorPercent !== undefined)
      sqlite
        .prepare('UPDATE orchestrations SET quota_floor_percent = ? WHERE id = ?')
        .run(body.quotaFloorPercent, id)
    // The policy each coding worker is approved with, and the acknowledgement that covered it (stored in the history).
    for (const [agentId, report] of reports) {
      storeWorkerPolicy(
        sqlite,
        id,
        agentId,
        {
          policyId: report.policyId!,
          policy: report.policy!,
          reach: report.reach!,
          reachBeyondWorkspace: report.reachBeyondWorkspace,
          acknowledged: body.acknowledgeCodingReach?.policyIds.includes(report.policyId!) ?? false,
        },
        now,
      )
    }
    if (reports.size > 0) {
      addHistory(
        sqlite,
        id,
        'coding_reach_acknowledged',
        {
          policyIds: [...reports.values()]
            .filter((report) => body.acknowledgeCodingReach?.policyIds.includes(report.policyId!))
            .map((report) => report.policyId),
        },
        now,
      )
      // The limits the person started with are journaled like any later change (verified after a restore).
      journalSoft(ctx, () =>
        ctx.journal.append({
          kind: 'authorization',
          orchestrationId: id,
          budgetUsd: body.budgetUsd ?? null,
          deadlineAt: body.deadlineAt ?? null,
          acceptUnknownSpend: false,
          codingSteps: body.codingSteps ?? ORCH_DEFAULTS.codingSteps,
          acceptUnknownCost: [...new Set(body.acceptUnknownCost ?? [])].sort(),
        }),
      )
    }
    // Freeze who this run was started with: the lead and every allowed agent (fix-h item 3).
    const freeze = sqlite.prepare(
      'INSERT INTO orc_agent_map (orchestration_id, agent_id, role, incarnation, updated_at) VALUES (?, ?, ?, ?, ?)',
    )
    freeze.run(id, body.leadAgentId, 'lead', lifecycle?.incarnation_id ?? 'untracked', now)
    for (const agentId of body.allowedAgents)
      freeze.run(
        id,
        agentId,
        'agent',
        lifecycleOf(sqlite, agentId)?.incarnation_id ?? 'untracked',
        now,
      )
    // 3.15: with a scan, the lead's first turn waits for it (settleHelpers adds 'started' when it is done).
    if (!body.helpers?.scan) addCause(sqlite, id, 'started', null, now)
    addHistory(
      sqlite,
      id,
      'created',
      { leadAgentId: body.leadAgentId, gatePolicy: body.gatePolicy },
      now,
    )
    touch(ctx, id)
    ctx.events.push(...emitBriefChange(sqlite, messageId, true))
  },
}

export type InsertMethods = typeof insertMethods
