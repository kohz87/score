import {
  type GateDecision,
  type LimitsDecision,
  type AbandonDecision,
  type RunControl,
  type QuotaDecision,
  type WaiverDecision,
  type WorkflowPolicyRemapDecision,
  type WorkflowRemapDecision,
  type WorkflowRetryDecision,
  type WorkflowRunSummary,
  type WorkflowTryAgainDecision,
} from '@score/contract'
import { HttpError } from '../../errors.ts'
import { type Ctx } from './ctx.ts'
import {
  abandonAttempts,
  decideGate,
  grantWaiver,
  pauseRun,
  answerQuota,
  policyRemapStep,
  resumeRun,
  setLimits,
  stopRun,
} from './decisions.ts'
import { readWorkerPolicy } from './coding-policy.ts'
import { decideNodeGate, remapWorkflow, retryNode, tryAgain } from '../workflows/decisions.ts'
import { nodesOf, requireWfRun } from '../workflows/store.ts'

import type { OrchestratorRuntime } from './executor-runtime.ts'

export const workflowDecisionMethods = {
  async decideWf(
    this: OrchestratorRuntime,
    id: string,
    fn: (ctx: Ctx) => void,
  ): Promise<WorkflowRunSummary> {
    this.db.read((sqlite) => this.requireWorkflowOrch(sqlite, id))
    await this.mutate((ctx) => {
      fn(ctx)
    })
    this.kick()
    return this.workflowSummary(id)
  },

  wfGateDecision(this: OrchestratorRuntime, id: string, gateId: string, body: GateDecision) {
    const isNode = this.db.read(
      (sqlite) =>
        sqlite
          .prepare('SELECT 1 FROM wf_gates WHERE orchestration_id = ? AND id = ?')
          .get(id, gateId) !== undefined,
    )
    return this.decideWf(id, (ctx) =>
      isNode ? decideNodeGate(ctx, id, gateId, body) : decideGate(ctx, id, gateId, body),
    )
  },

  wfRetry(this: OrchestratorRuntime, id: string, nodeId: string, body: WorkflowRetryDecision) {
    return this.decideWf(id, (ctx) => retryNode(ctx, id, nodeId, body))
  },

  wfTryAgain(
    this: OrchestratorRuntime,
    id: string,
    nodeId: string,
    body: WorkflowTryAgainDecision,
  ) {
    return this.decideWf(id, (ctx) => tryAgain(ctx, id, nodeId, body))
  },

  async wfRemap(this: OrchestratorRuntime, id: string, body: WorkflowRemapDecision) {
    this.db.read((sqlite) => this.requireWorkflowOrch(sqlite, id))
    // A coding agent's new version is judged on its policy as it is now (the report is asked before the transaction).
    const isCoding = this.db.read(
      (sqlite) => readWorkerPolicy(sqlite, id, body.agentId) !== undefined,
    )
    const report = isCoding ? await this.options.codingFacts?.report(body.agentId) : undefined
    return this.decideWf(id, (ctx) =>
      remapWorkflow(ctx, id, body, this.options.fence.journal, report),
    )
  },

  /**
   * "Use the new settings" for a coding node (7.7c §4): the node's agent is unchanged, its step's one suspended attempt takes
   * the agent's current policy, through the same per-step remap and re-admission as an orchestration step (7.7b §12a).
   */
  async wfPolicyRemap(
    this: OrchestratorRuntime,
    id: string,
    nodeId: string,
    body: WorkflowPolicyRemapDecision,
  ) {
    const agentId = this.db.read((sqlite) => {
      this.requireWorkflowOrch(sqlite, id)
      const def = requireWfRun(sqlite, id).definition.nodes.find((n) => n.id === nodeId)
      if (!def || def.kind !== 'agent')
        throw new HttpError(404, 'not_found', 'Couldn’t find that step.')
      return def.agentId
    })
    // Judged on the policy as it is now: the report is asked before the transaction.
    const report = await this.options.codingFacts?.report(agentId)
    return this.decideWf(id, (ctx) => {
      const node = nodesOf(ctx.sqlite, id).find((n) => n.node_id === nodeId)
      if (!node) throw new HttpError(404, 'not_found', 'Couldn’t find that step.')
      if (node.revision !== body.expectedNodeRevision)
        throw new HttpError(409, 'conflict', 'The step changed while you were looking.', {
          currentRevision: node.revision,
        })
      if (node.step_id === null)
        throw new HttpError(409, 'conflict', 'This step isn’t waiting for new settings.')
      policyRemapStep(
        ctx,
        id,
        node.step_id,
        {
          agentId,
          policyId: body.policyId,
          ...(body.acknowledgeCodingReach === undefined
            ? {}
            : { acknowledgeCodingReach: body.acknowledgeCodingReach }),
          orchestrationRevision: body.orchestrationRevision,
        },
        report,
      )
    })
  },

  /** The answer to a held coding node (8.6): the node's step is the one the decision names. */
  wfQuotaDecision(this: OrchestratorRuntime, id: string, nodeId: string, body: QuotaDecision) {
    return this.decideWf(id, (ctx) => {
      const node = nodesOf(ctx.sqlite, id).find((n) => n.node_id === nodeId)
      if (!node) throw new HttpError(404, 'not_found', 'Couldn’t find that step.')
      if (node.step_id === null)
        throw new HttpError(409, 'conflict', 'This step isn’t held for a low limit.')
      answerQuota(ctx, id, node.step_id, body)
    })
  },

  wfLimits(this: OrchestratorRuntime, id: string, body: LimitsDecision) {
    return this.decideWf(id, (ctx) => setLimits(ctx, id, body, this.storageFits))
  },

  wfPause(this: OrchestratorRuntime, id: string, body: RunControl) {
    return this.decideWf(id, (ctx) => pauseRun(ctx, id, body))
  },

  wfResume(this: OrchestratorRuntime, id: string, body: RunControl) {
    return this.decideWf(id, (ctx) => resumeRun(ctx, id, body))
  },

  wfStop(this: OrchestratorRuntime, id: string) {
    return this.decideWf(id, (ctx) => stopRun(ctx, id))
  },

  wfWaiver(this: OrchestratorRuntime, id: string, body: WaiverDecision) {
    return this.decideWf(id, (ctx) => grantWaiver(ctx, id, body))
  },

  wfAbandon(this: OrchestratorRuntime, id: string, body: AbandonDecision) {
    return this.decideWf(id, (ctx) => abandonAttempts(ctx, id, body))
  },
}

export type WorkflowDecisionMethods = typeof workflowDecisionMethods

export type WorkflowDecisionPublicMethods = Pick<
  WorkflowDecisionMethods,
  | 'wfGateDecision'
  | 'wfRetry'
  | 'wfTryAgain'
  | 'wfRemap'
  | 'wfPolicyRemap'
  | 'wfQuotaDecision'
  | 'wfLimits'
  | 'wfPause'
  | 'wfResume'
  | 'wfStop'
  | 'wfWaiver'
  | 'wfAbandon'
>
