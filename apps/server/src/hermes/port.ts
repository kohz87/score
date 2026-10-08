import {
  ApprovalChoiceSchema,
  ApprovalSchema,
  type AgentSummary,
  type SystemStatus,
} from '@score/contract'
import { z } from 'zod'
import type { AgentDetail } from '@score/contract'
import type { ScoreDb } from '../db/index.ts'
import type { IngestResult, Observation } from '../hub/ingest.ts'

export interface ObservationSink {
  submit(obs: Observation): Promise<IngestResult>
}

export const DecisionDeliveryRequestSchema = z.object({
  approvalId: z.string().min(1),
  origin: ApprovalSchema.shape.origin,
  profile: z.string().min(1),
  runId: z.string().min(1).nullable(),
  requestId: z.string().min(1),
  choice: ApprovalChoiceSchema,
})

export const TaskActionRequestSchema = z
  .object({
    taskId: z.string().min(1).max(256),
    action: z.enum(['comment', 'unblock']),
    text: z
      .string()
      .max(2000)
      .refine((value) => !value.includes('\0'))
      .optional(),
  })
  .refine((req) => req.action !== 'comment' || Boolean(req.text?.trim()))

export type CompatibilityEvaluation = SystemStatus['compatibility'] & {
  matchedHermes?: { version: string; codeSha: string }
}

export interface HermesPort {
  readonly mode: 'live' | 'fake'
  start(sink: ObservationSink): Promise<void>
  stop(): Promise<void>
  status(): Pick<SystemStatus, 'hermes' | 'bridge' | 'agentIsolation' | 'degraded'> & {
    compatibility: CompatibilityEvaluation
  }
  listAgents(): Promise<AgentSummary[]>
  listAgentDetails(): Promise<AgentDetail[]>
  startRun(req: {
    agentId: string
    input: string
    turnId: string
    sessionId?: string
    model?: string
  }): Promise<{ runId: string }>
  stopRun(req: { agentId: string; runId: string }): Promise<void>
  taskAction(req: z.infer<typeof TaskActionRequestSchema>): Promise<{ hermesStatus: string }>
  deliverDecision(
    req: z.infer<typeof DecisionDeliveryRequestSchema>,
  ): Promise<'applied' | 'not_pending' | 'failed'>
}

export interface Scheduler {
  now(): number
  setTimeout(callback: () => void, delayMs: number): unknown
  clearTimeout(handle: unknown): void
}

export interface HermesPortDeps {
  /** The server's shared Score DB (single writer, D1). The live port never opens its own. */
  db?: ScoreDb
  scheduler?: Scheduler
  onError?: (error: unknown) => void
}

export class ApprovalDeliveryError extends Error {
  constructor(
    readonly code: string,
    readonly maybeApplied: boolean,
    readonly retryable: boolean,
  ) {
    super('Approval delivery failed')
    this.name = 'ApprovalDeliveryError'
  }
}
