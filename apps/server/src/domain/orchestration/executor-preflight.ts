import {
  type AgentSummary,
  ORCH_ACKNOWLEDGEMENT_TEXT,
  ORCH_CAPACITY,
  ORCH_DEFAULTS,
  type Preflight,
  type PreflightCheck,
} from '@score/contract'
import { agentAdmits } from '../agent-lifecycle.ts'
import { TOOLS } from './commands.ts'
import { reserveFor, codingItemsFor, codingUnsentBytes } from './ops.ts'
import { assertOrchestrationWorkers, type WorkerReport } from './supported-agents.ts'

import type { OrchestratorRuntime } from './executor-runtime.ts'
import { capacityUsed, quotaUsed } from './executor-capacity.ts'

export const preflightMethods = {
  // ----------------------------------------------------------------------------------------------- preflight, create

  /**
   * `agents` is the team as the caller sees it (the HTTP routes pass the cached agent directory, which is fast against a
   * live Hermes); without it the adapter is asked.
   */
  async preflight(
    this: OrchestratorRuntime,
    leadAgentId: string,
    allowedAgents: string[],
    agents?: Pick<AgentSummary, 'id' | 'served' | 'runtime'>[],
    maxConcurrentSteps?: number,
  ): Promise<Preflight> {
    return (await this.preflightWith(leadAgentId, allowedAgents, agents, maxConcurrentSteps))
      .preflight
  },

  /** The preflight and, for each coding worker, the full report its policy came from (create stores the policy). */
  async preflightWith(
    this: OrchestratorRuntime,
    leadAgentId: string,
    allowedAgents: string[],
    agents?: Pick<AgentSummary, 'id' | 'served' | 'runtime'>[],
    // F2 #2: the quota check reserves unsent coding inventory for the concurrency the request asks for.
    maxConcurrentSteps: number = ORCH_DEFAULTS.maxConcurrentSteps,
  ): Promise<{ preflight: Preflight; reports: Map<string, WorkerReport> }> {
    const { port, access } = this.options
    const fake = port.mode === 'fake'
    const checks: PreflightCheck[] = []
    const add = (id: PreflightCheck['id'], status: PreflightCheck['status'], message: string) =>
      checks.push({ id, status, message })
    const team = agents ?? (await port.listAgents())
    assertOrchestrationWorkers(leadAgentId, allowedAgents, team, this.options.codingFacts)
    const known = new Map(team.map((agent) => [agent.id, agent]))
    // Each coding worker: can it take a step now, and what policy would the person approve (7.7b §3).
    const reports = new Map<string, WorkerReport>()
    for (const id of new Set(allowedAgents)) {
      const runtime = known.get(id)?.runtime
      if (runtime && runtime !== 'hermes' && this.options.codingFacts)
        reports.set(id, await this.options.codingFacts.report(id))
    }
    const ready = (id: string): string | undefined => {
      const agent = known.get(id)
      if (!agent) return `${id} is not a team member`
      if (!this.db.read((sqlite) => agentAdmits(sqlite, id)))
        return `${id} is not ready for new work`
      if (!fake && !agent.served) return `${id} is not served by Hermes right now`
      return undefined
    }
    add(
      'listener',
      fake || this.options.mcpAvailable ? 'ok' : 'fail',
      fake
        ? 'The fake adapter runs a scripted lead; no MCP listener is needed'
        : this.options.mcpAvailable
          ? 'The loopback MCP listener is up'
          : 'Orchestrations need remote mode: the lead reaches its tools through the loopback MCP listener',
    )
    const leadProblem = ready(leadAgentId)
    add('lead_ready', leadProblem ? 'fail' : 'ok', leadProblem ?? `${leadAgentId} is ready`)
    const state = access.get(leadAgentId)
    add(
      'lead_mcp_access',
      fake || state.enabled ? 'ok' : 'fail',
      fake || state.enabled
        ? 'MCP access is on for the lead (the writes switch is not needed)'
        : `Turn on MCP access for ${leadAgentId} in Team › Tools`,
    )
    add(
      'lead_mcp_token',
      fake || state.hasToken ? 'ok' : 'fail',
      fake || state.hasToken
        ? 'The lead has an MCP token'
        : `Create an MCP token for ${leadAgentId} and add it to the profile`,
    )
    const problems = [
      ...(allowedAgents.length === 0 ? ['choose at least one agent for the steps'] : []),
      ...(allowedAgents.includes(leadAgentId)
        ? [`${leadAgentId} leads this run and cannot also do steps`]
        : []),
      ...allowedAgents.flatMap((id) => {
        const problem = ready(id)
        return problem ? [problem] : []
      }),
      ...[...reports].flatMap(([id, report]) =>
        report.readiness === 'ready' ? [] : [`${id}: ${report.detail ?? report.readiness}`],
      ),
    ]
    add(
      'allowed_agents',
      problems.length ? 'fail' : 'ok',
      problems.join('; ') || 'All step agents are ready',
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
      running < ORCH_CAPACITY.runningOrchestrations
        ? `${running} of ${ORCH_CAPACITY.runningOrchestrations} orchestrations are running`
        : `${ORCH_CAPACITY.runningOrchestrations} orchestrations are already running.`,
    )
    const reserve = reserveFor(
      12,
      20,
      reports.size > 0 ? codingItemsFor(12, ORCH_DEFAULTS.codingSteps) : 0,
      reports.size > 0 ? codingUnsentBytes(12, maxConcurrentSteps) : 0,
    )
    const fits = this.db.read((sqlite) => quotaUsed(sqlite) + reserve <= this.quotaBytes)
    add(
      'quota',
      fits ? 'ok' : 'fail',
      fits
        ? 'There is room for another run'
        : 'Orchestration storage is full; remove old runs first',
    )
    // Hermes caches the MCP tool list per connection: the lead's serving process must list every orch.* tool, the ones a
    // Score upgrade added included (3.13.2: a list from before 3.13 lacked orch.check and orch.vote, and passed).
    const required: readonly string[] = TOOLS
    // The adapter's answer where it can ask (fake); otherwise what Score's own MCP server last handed the lead (3.7.8).
    const ownList = !leadProblem && !port.mcpTools
    const handed = ownList ? access.listed(leadAgentId) : null
    const listed = leadProblem
      ? null
      : port.mcpTools
        ? await port.mcpTools(leadAgentId).catch(() => null)
        : (handed?.names ?? null)
    if (listed) {
      const missing = required.filter((name) => !listed.includes(name))
      add(
        'tool_readiness',
        missing.length ? 'fail' : 'ok',
        missing.length
          ? `The lead's Hermes ${handed ? 'was last handed a tool list without' : 'does not list'} ${missing.join(', ')}. Reload MCP (/reload-mcp in that profile, or restart its gateway), then try again.`
          : 'The lead sees every orch.* tool',
      )
    } else if (ownList)
      add(
        'tool_readiness',
        'unknown',
        "The lead's Hermes hasn't asked Score for its tools since its MCP key was set up. Reload MCP in that profile (/reload-mcp, or restart its gateway) so Score can check them.",
      )
    else
      add(
        'tool_readiness',
        fake ? 'ok' : 'unknown',
        fake
          ? 'Scripted lead'
          : 'Score cannot see which MCP tools the lead has. Hermes caches the tool list per connection, so after Score is upgraded reload MCP (/reload-mcp, or restart the gateway) before starting.',
      )
    const preflight: Preflight = {
      ok: checks.every((check) => check.status !== 'fail'),
      checks,
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
        'every-step': 'You approve every assignment before it starts.',
        'lead-asks':
          'A step starts without approval unless the lead asks you. Steps wait until the lead has finished its turn so it can ask first.',
        none: 'Assignments start without approval. Budget uncertainty and agent tool approvals still reach you.',
      },
      acknowledgementText: ORCH_ACKNOWLEDGEMENT_TEXT,
      defaults: {
        maxSteps: 12,
        maxLeadTurns: 20,
        maxConcurrentSteps: 2,
        leadTurnEstimateUsd: 0.25,
        stepEstimateUsd: 0.5,
        codingSteps: ORCH_DEFAULTS.codingSteps,
      },
      reserveBytes: reserve,
    }
    return { preflight, reports }
  },
}

export type PreflightMethods = typeof preflightMethods

export type PreflightPublicMethods = Pick<PreflightMethods, 'preflight'>
