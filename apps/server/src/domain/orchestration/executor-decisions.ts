import {
  type GateDecision,
  type InquiryAnswer,
  type LimitsDecision,
  type OrchestrationSummary,
  type AbandonDecision,
  type RunControl,
  type PolicyRemapDecision,
  type QuotaDecision,
  type RemapDecision,
  type WaiverDecision,
} from '@score/contract'
import { type Ctx } from './ctx.ts'
import {
  abandonAttempts,
  answerInquiry,
  decideGate,
  expectRevision,
  personStopsStep,
  grantWaiver,
  remapAgent,
  pauseRun,
  answerQuota,
  policyRemapStep,
  resumeRun,
  setLimits,
  stopRun,
} from './decisions.ts'
import { type GlobalFenceStore } from './fence.ts'
import { readWorkerPolicy } from './coding-policy.ts'
import { personRunsCheck, waiveCheck } from './checks.ts'

import type { OrchestratorRuntime } from './executor-runtime.ts'
import { requireLeadOrch } from './executor-reads.ts'

export const decisionMethods = {
  // ---------------------------------------------------------------------------------------------- human decisions

  async decide(
    this: OrchestratorRuntime,
    id: string,
    fn: (ctx: Ctx) => void,
  ): Promise<OrchestrationSummary> {
    // A workflow run answers 404 before anything changes: its controls are /api/workflow-runs/:id/….
    this.db.read((sqlite) => requireLeadOrch(sqlite, id))
    await this.mutate((ctx) => {
      fn(ctx)
    })
    this.kick()
    return this.summary(id)
  },

  gateDecision(this: OrchestratorRuntime, id: string, gateId: string, body: GateDecision) {
    return this.decide(id, (ctx) => decideGate(ctx, id, gateId, body))
  },

  inquiryAnswer(this: OrchestratorRuntime, id: string, inquiryId: string, body: InquiryAnswer) {
    return this.decide(id, (ctx) => answerInquiry(ctx, id, inquiryId, body))
  },

  limits(this: OrchestratorRuntime, id: string, body: LimitsDecision) {
    return this.decide(id, (ctx) => setLimits(ctx, id, body, this.storageFits))
  },

  pause(this: OrchestratorRuntime, id: string, body: RunControl) {
    return this.decide(id, (ctx) => pauseRun(ctx, id, body))
  },

  resume(this: OrchestratorRuntime, id: string, body: RunControl) {
    return this.decide(id, (ctx) => resumeRun(ctx, id, body))
  },

  /** 3.14: the person stops one step (the lead is told and can reassign it). */
  stopStep(this: OrchestratorRuntime, id: string, stepId: string, body: RunControl) {
    return this.decide(id, (ctx) => personStopsStep(ctx, id, stepId, body))
  },

  /** 3.13: the person runs the job's check now. */
  runCheck(this: OrchestratorRuntime, id: string, body: RunControl) {
    return this.decide(id, (ctx) => {
      const o = requireLeadOrch(ctx.sqlite, id)
      expectRevision(o, body.orchestrationRevision)
      personRunsCheck(ctx, o)
    })
  },

  /** 3.13: the person lets the job finish successfully without a passing check. */
  waiveCheck(this: OrchestratorRuntime, id: string, body: RunControl) {
    return this.decide(id, (ctx) => {
      const o = requireLeadOrch(ctx.sqlite, id)
      expectRevision(o, body.orchestrationRevision)
      waiveCheck(ctx, o)
    })
  },

  /** Stop ignores a stale page: it can only reduce risk. */
  stop(this: OrchestratorRuntime, id: string) {
    return this.decide(id, (ctx) => stopRun(ctx, id))
  },

  async remap(this: OrchestratorRuntime, id: string, body: RemapDecision) {
    this.db.read((sqlite) => requireLeadOrch(sqlite, id))
    // A coding worker's replacement is judged on its policy as it is now (the report is asked before the transaction).
    const isCoding = this.db.read(
      (sqlite) => readWorkerPolicy(sqlite, id, body.agentId) !== undefined,
    )
    const report = isCoding ? await this.options.codingFacts?.report(body.agentId) : undefined
    return this.decide(id, (ctx) => remapAgent(ctx, id, body, report))
  },

  /** "Use the new settings" for a step blocked `agent_changed` (7.7b §12a). */
  async policyRemap(
    this: OrchestratorRuntime,
    id: string,
    stepId: string,
    body: PolicyRemapDecision,
  ) {
    this.db.read((sqlite) => requireLeadOrch(sqlite, id))
    const report = await this.options.codingFacts?.report(body.agentId)
    return this.decide(id, (ctx) => policyRemapStep(ctx, id, stepId, body, report))
  },

  /** The answer to a step held because its coding agent is below its quota floor (8.6). */
  quotaDecision(this: OrchestratorRuntime, id: string, stepId: string, body: QuotaDecision) {
    return this.decide(id, (ctx) => answerQuota(ctx, id, stepId, body))
  },

  waiver(this: OrchestratorRuntime, id: string, body: WaiverDecision) {
    return this.decide(id, (ctx) => grantWaiver(ctx, id, body))
  },

  abandon(this: OrchestratorRuntime, id: string, body: AbandonDecision) {
    return this.decide(id, (ctx) => abandonAttempts(ctx, id, body))
  },

  fence(this: OrchestratorRuntime): ReturnType<GlobalFenceStore['view']> {
    return this.options.fence.view()
  },

  liftFence(
    this: OrchestratorRuntime,
    expectedRevision: number,
    note: string | undefined,
  ): ReturnType<GlobalFenceStore['view']> {
    this.options.fence.lift(expectedRevision, note)
    this.kick()
    return this.options.fence.view()
  },
}

export type DecisionMethods = typeof decisionMethods

export type DecisionPublicMethods = Pick<
  DecisionMethods,
  | 'gateDecision'
  | 'inquiryAnswer'
  | 'limits'
  | 'pause'
  | 'resume'
  | 'stopStep'
  | 'runCheck'
  | 'waiveCheck'
  | 'stop'
  | 'remap'
  | 'policyRemap'
  | 'quotaDecision'
  | 'waiver'
  | 'abandon'
  | 'fence'
  | 'liftFence'
>
