import type { DatabaseSync } from 'node:sqlite'
import type { ScoreDb } from '../../db/index.ts'
import type { Ingest } from '../../hub/ingest.ts'
import type { CheckProcess } from '../../runtimes/check/spawn-check.ts'
import type { SpendReader } from './budget.ts'
import { type AdmissionMethods, admissionMethods } from './executor-admission.ts'
import { type CheckMethods, checkMethods } from './executor-checks.ts'
import { type CodingMethods, codingMethods } from './executor-coding.ts'
import { type CreateMethods, createMethods } from './executor-create.ts'
import { type DecisionMethods, decisionMethods } from './executor-decisions.ts'
import { type DispatchMethods, dispatchMethods } from './executor-dispatch.ts'
import { type InsertMethods, insertMethods } from './executor-insert.ts'
import { type LifecycleMethods, lifecycleMethods } from './executor-lifecycle.ts'
import { type MaintenanceMethods, maintenanceMethods } from './executor-maintenance.ts'
import { type ObservationMethods, observationMethods } from './executor-observation.ts'
import { type PreflightMethods, preflightMethods } from './executor-preflight.ts'
import { type ReadMethods, readMethods } from './executor-reads.ts'
import { type RecoveryMethods, recoveryMethods } from './executor-recovery.ts'
import { type RecoveryRepairMethods, recoveryRepairMethods } from './executor-recovery-repair.ts'
import { type ReleaseMethods, releaseMethods } from './executor-release.ts'
import { type SendMethods, sendMethods } from './executor-send.ts'
import { type SettlingMethods, settlingMethods } from './executor-settling.ts'
import { type SignalMethods, signalMethods } from './executor-signals.ts'
import { type StopMethods, stopMethods } from './executor-stops.ts'
import type { OrchestratorOptions } from './executor-types.ts'
import { type WorkflowCreateMethods, workflowCreateMethods } from './executor-workflow-create.ts'
import {
  type WorkflowDecisionMethods,
  workflowDecisionMethods,
} from './executor-workflow-decisions.ts'
import {
  type WorkflowPreflightMethods,
  workflowPreflightMethods,
} from './executor-workflow-preflight.ts'

export interface OrchestratorRuntime
  extends
    LifecycleMethods,
    ReadMethods,
    PreflightMethods,
    CreateMethods,
    InsertMethods,
    DecisionMethods,
    WorkflowPreflightMethods,
    WorkflowCreateMethods,
    WorkflowDecisionMethods,
    SignalMethods,
    RecoveryRepairMethods,
    RecoveryMethods,
    SettlingMethods,
    AdmissionMethods,
    DispatchMethods,
    SendMethods,
    ReleaseMethods,
    CodingMethods,
    ObservationMethods,
    CheckMethods,
    StopMethods,
    MaintenanceMethods {
  readonly db: ScoreDb
  readonly ingest: Ingest
  readonly clock: () => number
  readonly spend: SpendReader
  readonly quotaBytes: number
  readonly retryMs: number
  /** Whether this adapter can prove a session's compression lineage is complete (only the fake one can). */
  readonly lineageProvable: boolean
  pumping: Promise<void> | undefined
  again: boolean
  closed: boolean
  timer: NodeJS.Timeout | undefined
  maintenanceTimer: NodeJS.Timeout | undefined
  unsubscribe: (() => void) | undefined
  readonly cooldown: Map<string, number>
  readonly stopTried: Map<string, { at: number; delay: number; fails: number }>
  readonly stopJobs: Map<string, Promise<void>>
  abandonStops: boolean
  readonly fingerprints: Map<string, string>
  readonly ownershipSeen: Map<string, string>
  readonly served: Map<string, boolean>
  readonly checkJobs: Map<string, { orchId: string; proc: CheckProcess }>
  readonly checksInFlight: Set<string>
  readonly resetWakes: Set<string>
  readonly options: OrchestratorOptions
  readonly storageFits: (sqlite: DatabaseSync, extra: number) => boolean
}

type WithoutThis<T> = T extends (this: OrchestratorRuntime, ...args: infer Args) => infer Result
  ? (...args: Args) => Result
  : never

type PublicMethods<T, K extends keyof T> = { [P in K]: WithoutThis<T[P]> }

export type OrchestratorPublicMethods = PublicMethods<
  LifecycleMethods,
  'start' | 'close' | 'kick' | 'pump' | 'idle' | 'announceFence'
> &
  PublicMethods<
    ReadMethods,
    'list' | 'snapshot' | 'events' | 'summary' | 'recordHold' | 'fenceStore'
  > &
  PublicMethods<PreflightMethods, 'preflight'> &
  PublicMethods<CreateMethods, 'create'> &
  PublicMethods<
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
  > &
  PublicMethods<
    WorkflowPreflightMethods,
    | 'workflowRuns'
    | 'workflowSnapshot'
    | 'workflowEvents'
    | 'workflowSummary'
    | 'validateWorkflow'
    | 'workflowPreflight'
  > &
  PublicMethods<WorkflowCreateMethods, 'createWorkflowRun'> &
  PublicMethods<
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
  > &
  PublicMethods<SignalMethods, 'agentReady' | 'admissionChanged' | 'handleTool'> &
  PublicMethods<RecoveryMethods, 'recover'> &
  PublicMethods<MaintenanceMethods, 'maintenance'>

const executorMethods = {
  ...lifecycleMethods,
  ...readMethods,
  ...preflightMethods,
  ...createMethods,
  ...insertMethods,
  ...decisionMethods,
  ...workflowPreflightMethods,
  ...workflowCreateMethods,
  ...workflowDecisionMethods,
  ...signalMethods,
  ...recoveryRepairMethods,
  ...recoveryMethods,
  ...settlingMethods,
  ...admissionMethods,
  ...dispatchMethods,
  ...sendMethods,
  ...releaseMethods,
  ...codingMethods,
  ...observationMethods,
  ...checkMethods,
  ...stopMethods,
  ...maintenanceMethods,
}

/** Installs the executor's method modules on the class prototype with class-method descriptors. */
export function installExecutorMethods(prototype: object): void {
  for (const [name, method] of Object.entries(executorMethods)) {
    Object.defineProperty(prototype, name, {
      value: method,
      writable: true,
      enumerable: false,
      configurable: true,
    })
  }
}
