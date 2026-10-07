import type { AgentSummary, ApprovalChoice, SystemStatus } from '@score/contract'
import type { ScoreDb } from '../db/index.ts'
import type { IngestResult, Observation } from '../hub/ingest.ts'

export interface ObservationSink {
  submit(obs: Observation): Promise<IngestResult>
}

export interface HermesPort {
  readonly mode: 'live' | 'fake'
  start(sink: ObservationSink): Promise<void>
  stop(): Promise<void>
  status(): Pick<
    SystemStatus,
    'hermes' | 'bridge' | 'compatibility' | 'agentIsolation' | 'degraded'
  >
  listAgents(): Promise<AgentSummary[]>
  startRun(req: {
    agentId: string
    input: string
    turnId: string
    sessionId?: string
    model?: string
  }): Promise<{ runId: string }>
  stopRun(req: { agentId: string; runId: string }): Promise<void>
  deliverDecision(req: {
    approvalId: string
    choice: ApprovalChoice
  }): Promise<'applied' | 'not_pending' | 'failed'>
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
