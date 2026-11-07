import {
  type AgentSummary,
  ORCH_ACKNOWLEDGEMENT_TEXT,
  ORCH_CAPACITY,
  ORCH_DEFAULTS,
  type ValidationResult,
  type WorkflowDefinition,
  type WorkflowPreflight,
  type WorkflowRunEvents,
  type WorkflowRunList,
  type WorkflowRunSnapshot,
  type WorkflowRunSummary,
} from '@score/contract'
import { type DatabaseSync } from 'node:sqlite'
import { HttpError } from '../../errors.ts'
import { headSeq } from '../../hub/snapshot.ts'
import { agentAdmits, lifecycleOf } from '../agent-lifecycle.ts'
import { codingItemsFor, codingUnsentBytes } from './ops.ts'
import { workflowDetailOf, workflowEventsOf, workflowSummaryOf } from '../workflows/views.ts'
import { readVersion } from '../workflows/definitions.ts'
import { validateDefinition } from '../workflows/definition.ts'
import {
  codingAgentsOf,
  codingNodeIdsOf,
  validateWorkflowAgents,
  withAgentIssues,
} from '../workflows/agents.ts'
import { type WorkerReport } from './supported-agents.ts'
import { agentIdsOf, defaultCodingSteps, stepBudgetOf, workflowReserve } from '../workflows/runs.ts'
import { listWorkflowOrchs, requireOrch, type OrchRow } from './store.ts'

import type { OrchestratorRuntime } from './executor-runtime.ts'
import { capacityUsed, quotaUsed } from './executor-capacity.ts'

export const workflowPreflightMethods = {
  // ------------------------------------------------------------------------------------------------------ workflows

  requireWorkflowOrch(this: OrchestratorRuntime, sqlite: DatabaseSync, id: string): OrchRow {
    const o = requireOrch(sqlite, id)
    if (o.planner !== 'workflow') throw new HttpError(404, 'not_found', 'Couldn’t find that run.')
    return o
  },

  workflowRuns(this: OrchestratorRuntime): WorkflowRunList {
    return this.db.read((sqlite) => ({
      asOfSeq: headSeq(sqlite),
      items: listWorkflowOrchs(sqlite).map((o) =>
        workflowSummaryOf(sqlite, o, this.options.fence.journal, this.options.codingFacts),
      ),
    }))
  },

  workflowSnapshot(this: OrchestratorRuntime, id: string): WorkflowRunSnapshot {
    return this.db.read((sqlite) => ({
      asOfSeq: headSeq(sqlite),
      run: workflowDetailOf(
        sqlite,
        this.requireWorkflowOrch(sqlite, id),
        new Date(this.nowMs()).toISOString(),
        {
          lineageProvable: this.lineageProvable,
          journal: this.options.fence.journal,
          ...(this.options.codingFacts ? { facts: this.options.codingFacts } : {}),
        },
      ),
    }))
  },

  workflowEvents(this: OrchestratorRuntime, id: string): WorkflowRunEvents {
    return this.db.read((sqlite) => ({
      asOfSeq: headSeq(sqlite),
      events: workflowEventsOf(sqlite, this.requireWorkflowOrch(sqlite, id)),
    }))
  },

  workflowSummary(this: OrchestratorRuntime, id: string): WorkflowRunSummary {
    return this.db.read((sqlite) =>
      workflowSummaryOf(
        sqlite,
        this.requireWorkflowOrch(sqlite, id),
        this.options.fence.journal,
        this.options.codingFacts,
      ),
    )
  },

  /**
   * The one runtime validation of a workflow (7.7c §1): the graph rules plus the team and host rules for coding agents.
   * Validate, save, new versions, preflight and start all call this, so none of them can disagree.
   */
  async validateWorkflow(
    this: OrchestratorRuntime,
    definition: WorkflowDefinition,
    agents?: Pick<AgentSummary, 'id' | 'runtime'>[],
  ): Promise<ValidationResult> {
    const team = agents ?? (await this.options.port.listAgents())
    return withAgentIssues(
      validateDefinition(definition),
      validateWorkflowAgents(definition, team, this.options.codingFacts),
    )
  },

  async workflowPreflight(
    this: OrchestratorRuntime,
    workflowId: string,
    version: number,
    agents?: Pick<AgentSummary, 'id' | 'served' | 'runtime'>[],
    maxConcurrentSteps?: number,
  ): Promise<WorkflowPreflight> {
    return (await this.workflowPreflightWith(workflowId, version, agents, maxConcurrentSteps))
      .preflight
  },

  /** The preflight and, for each coding agent of the workflow, the full report its policy came from (start stores it). */
  async workflowPreflightWith(
    this: OrchestratorRuntime,
    workflowId: string,
    version: number,
    agents?: Pick<AgentSummary, 'id' | 'served' | 'runtime'>[],
    maxConcurrentSteps: number = ORCH_DEFAULTS.maxConcurrentSteps,
  ): Promise<{ preflight: WorkflowPreflight; reports: Map<string, WorkerReport> }> {
    const { port } = this.options
    const fake = port.mode === 'fake'
    const checks: WorkflowPreflight['checks'] = []
    const add = (
      id: WorkflowPreflight['checks'][number]['id'],
      status: 'ok' | 'fail' | 'unknown',
      message: string,
    ) => checks.push({ id, status, message })
    const found = this.db.read((sqlite) => readVersion(sqlite, workflowId, version))
    const team = agents ?? (await port.listAgents())
    const validation = await this.validateWorkflow(found.definition, team)
    add(
      'definition',
      validation.ok ? 'ok' : 'fail',
      validation.ok
        ? 'The workflow is valid'
        : `${validation.issues.length} problems in the workflow`,
    )
    const ids = agentIdsOf(found)
    const known = new Map(team.map((agent) => [agent.id, agent]))
    // Each coding agent of the workflow: can it take a step now, and what would the person approve (7.7c §2). Only asked
    // for a definition the team and host can run at all.
    const reports = new Map<string, WorkerReport>()
    if (validation.ok && this.options.codingFacts)
      for (const id of codingAgentsOf(found.definition, team))
        reports.set(id, await this.options.codingFacts.report(id))
    const problems = [
      ...ids.flatMap((id) => {
        const agent = known.get(id)
        if (!agent) return [`${id} is not a team member`]
        if (!this.db.read((sqlite) => agentAdmits(sqlite, id)))
          return [`${id} is not ready for new work`]
        if (!fake && !agent.served) return [`${id} is not served by Hermes right now`]
        return []
      }),
      ...[...reports].flatMap(([id, report]) =>
        report.readiness === 'ready' ? [] : [`${id}: ${report.detail ?? report.readiness}`],
      ),
    ]
    add('agents', problems.length ? 'fail' : 'ok', problems.join('; ') || 'All agents are ready')
    const mapping = this.db.read((sqlite) =>
      ids.map((agentId) => ({
        agentId,
        name: agentId,
        incarnation: lifecycleOf(sqlite, agentId)?.incarnation_id ?? 'untracked',
      })),
    )
    add(
      'mapping',
      'ok',
      `${mapping.length} agent${mapping.length === 1 ? '' : 's'} will be bound to this run`,
    )
    const fence = this.options.fence.view()
    add(
      'global_fence',
      fence.fenced ? 'fail' : 'ok',
      fence.fenced
        ? `Admission is fenced (${fence.reason}); review the list in Settings`
        : 'No fence',
    )
    add(
      'journal',
      fence.journal.ok && !fence.journal.sizeAlarm ? 'ok' : 'fail',
      fence.journal.ok
        ? fence.journal.sizeAlarm
          ? 'The execution journal is over its size alarm'
          : 'The execution journal is healthy'
        : 'The execution journal cannot be read',
    )
    const running = this.db.read((sqlite) => capacityUsed(sqlite))
    add(
      'capacity',
      running < ORCH_CAPACITY.runningOrchestrations ? 'ok' : 'fail',
      `${running} of ${ORCH_CAPACITY.runningOrchestrations} runs are using capacity`,
    )
    const steps = stepBudgetOf(found)
    const defaultSteps =
      reports.size > 0
        ? defaultCodingSteps(found, codingNodeIdsOf(found.definition, team))
        : undefined
    const reserve = workflowReserve(
      steps,
      defaultSteps === undefined ? 0 : codingItemsFor(steps, defaultSteps),
      defaultSteps === undefined ? 0 : codingUnsentBytes(steps, maxConcurrentSteps),
    )
    const fits = this.db.read((sqlite) => quotaUsed(sqlite) + reserve <= this.quotaBytes)
    add(
      'quota',
      fits ? 'ok' : 'fail',
      fits ? 'There is room for another run' : 'Run storage is full; remove old runs first',
    )
    const preflight: WorkflowPreflight = {
      ok: checks.every((check) => check.status !== 'fail'),
      checks,
      issues: validation.issues,
      mapping,
      workers: [...reports].map(([agentId, report]) => ({
        agentId,
        runtime: known.get(agentId)!.runtime as 'claude-code' | 'codex',
        readiness: report.readiness,
        detail: report.detail,
        policyId: report.policyId,
        reach: report.reach,
        reachBeyondWorkspace: report.reachBeyondWorkspace,
      })),
      gatePolicyNotes: {
        'gates-only':
          'Only gate nodes stop for you; agent steps start as soon as their inputs are ready.',
        'every-step': 'You approve every agent step before it starts, as well as the gate nodes.',
      },
      acknowledgementText: ORCH_ACKNOWLEDGEMENT_TEXT,
      spendNote: `Hermes reports tokens, often not dollars. Unknown cost is shown as unknown, never as zero, and spend of a live Hermes run is not settled: reservations are held until the run ends.${
        reports.size > 0
          ? ' Claude Code reports an estimated cost and Codex reports none; a coding step that ends without a cost counts as unknown cost.'
          : ''
      }`,
      maxSteps: found.maxSteps,
      reserveBytes: reserve,
      defaults: {
        gatePolicy: 'gates-only',
        maxConcurrentSteps: 2,
        stepEstimateUsd: 0.5,
        ...(defaultSteps === undefined ? {} : { codingSteps: defaultSteps }),
      },
    }
    return { preflight, reports }
  },
}

export type WorkflowPreflightMethods = typeof workflowPreflightMethods

export type WorkflowPreflightPublicMethods = Pick<
  WorkflowPreflightMethods,
  | 'workflowRuns'
  | 'workflowSnapshot'
  | 'workflowEvents'
  | 'workflowSummary'
  | 'validateWorkflow'
  | 'workflowPreflight'
>
