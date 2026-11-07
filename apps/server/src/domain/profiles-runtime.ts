import type {
  AgentImportRequest,
  AgentOperation,
  AgentPreview,
  AgentPreviewRequest,
} from '@score/contract'
import type { ScoreDb } from '../db/index.ts'
import type { HermesPort } from '../hermes/index.ts'
import type { Ingest } from '../hub/ingest.ts'
import { type BeginMethods, beginMethods } from './profiles-begin.ts'
import { type ControlMethods, controlMethods } from './profiles-controls.ts'
import { type PreviewMethods, previewMethods } from './profiles-preview.ts'
import { type RunMethods, runMethods } from './profiles-run.ts'
import type { PendingWork, StoredRequestValue } from './profiles-support.ts'
import type { ProfileImportStore } from './profile-imports.ts'

export interface ProfileOperationsRuntime {
  readonly db: ScoreDb
  readonly ingest: Ingest
  readonly port: HermesPort
  readonly clock: () => number
  readonly imports?: ProfileImportStore
  readonly flights: Map<string, Promise<void>>
  closed: boolean
  get(id: string): AgentOperation
  pending(name: string): PendingWork
  preview(raw: AgentPreviewRequest): Promise<AgentPreview>
  begin(
    request: AgentPreviewRequest,
    expectedHash: string,
    confirm?: boolean,
    imported?: { uploadId: string },
    confirmReuse?: boolean,
  ): Promise<AgentOperation>
  beginImport(
    request: AgentImportRequest,
    facts: { model: string | null; hasCredentials: boolean },
  ): Promise<AgentOperation>
  sweepImports(): void
  launch(id: string): void
  recover(): Promise<void>
  retry(id: string): Promise<AgentOperation>
  confirm(id: string, stepName: string): Promise<AgentOperation>
  refresh(id: string): Promise<AgentOperation>
  deleteRetrySafe(operation: AgentOperation): Promise<boolean>
  close(): Promise<void>
  save(operation: AgentOperation, identity?: string | null): Promise<void>
  run(id: string): Promise<void>
  rebaseline(
    operation: AgentOperation,
    stored: StoredRequestValue,
    identity: string | null,
  ): Promise<void>
  retire(operation: AgentOperation): Promise<void>
}

type WithoutThis<T> = T extends (
  this: ProfileOperationsRuntime,
  ...args: infer Args
) => infer Result
  ? (...args: Args) => Result
  : never

type PublicMethods<T, K extends keyof T> = { [P in K]: WithoutThis<T[P]> }

export type ProfileOperationsPublicMethods = PublicMethods<PreviewMethods, 'preview'> &
  PublicMethods<BeginMethods, 'begin' | 'beginImport' | 'sweepImports'> &
  PublicMethods<ControlMethods, 'recover' | 'retry' | 'confirm' | 'refresh' | 'close'>

const operationMethods = {
  ...previewMethods,
  ...beginMethods,
  ...controlMethods,
  ...runMethods,
}

/** Installs the operation's method modules on the class prototype with class-method descriptors. */
export function installProfileOperationMethods(prototype: object): void {
  for (const [name, method] of Object.entries(operationMethods)) {
    Object.defineProperty(prototype, name, {
      value: method,
      writable: true,
      enumerable: false,
      configurable: true,
    })
  }
}

export type { BeginMethods, ControlMethods, PreviewMethods, RunMethods }
