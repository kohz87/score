import type { CodingModelsResponse, CodingUsage } from '@score/contract'
import { HttpError } from '../../errors.ts'
import type { RootPolicy } from '../../workspace/policy.ts'
import type { CliLocator } from './cli.ts'
import type { ActiveRun, CodingRuntimeDeps } from './service-types.ts'
import type { BackendStatus } from './unit-backend.ts'

export class CodingRuntimeBase {
  protected readonly active = new Map<string, ActiveRun>()
  protected readonly queues = new Map<string, Promise<void>>()
  /** Terminal results that are being saved in the background after the first attempts failed (S3-004). */
  protected readonly deliveries = new Map<string, Promise<void>>()
  protected closed = false
  protected readonly usageCache = new Map<string, { at: number; value: CodingUsage }>()
  protected readonly modelsCache = new Map<string, { at: number; value: CodingModelsResponse }>()
  protected readonly shownProblems = new Map<string, { at: number; problem: string | null }>()
  protected readonly admissions = new Map<string, Promise<void>>()
  protected readonly reapers = new Map<string, Promise<boolean>>()
  protected readonly wakers = new Set<() => void>()

  constructor(protected readonly deps: CodingRuntimeDeps) {}

  /** How coding runs are launched right now, with the capability check behind it (docs/API-CONTRACT.md §8). */
  backend(): BackendStatus {
    const status = this.deps.unit?.status ?? {
      kind: 'process-group' as const,
      checks: [],
      checkedAt: new Date().toISOString(),
      note: 'Runs without a supervisor: tools a coding CLI started may keep running until Score restarts and stops them.',
    }
    const frozen = this.deps.frozen?.() ?? null
    if (frozen === null) return status
    // The card says why nothing runs and what to do (docs/WRITING.md); the checks stay as they were.
    return {
      ...status,
      note: frozen,
      checks: [...status.checks, { name: 'history', ok: false, detail: frozen }],
    }
  }
  /** "Check again": reruns the capability check; new runs follow its answer. */
  async checkBackend(): Promise<BackendStatus> {
    return this.deps.unit ? this.deps.unit.check() : this.backend()
  }

  get locator(): CliLocator {
    return this.deps.locator
  }
  get policy(): RootPolicy {
    return this.deps.policy
  }

  protected assertOpen(): void {
    if (this.closed)
      throw new HttpError(
        503,
        'shutting_down',
        'Score is shutting down. Try again once it has restarted.',
        { cause: 'restart' },
      )
  }
}
