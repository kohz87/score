import { randomUUID } from 'node:crypto'
import { Control, STOP_CAUSE } from './unit-backend-helpers.ts'
import { UnitBackendDrive } from './unit-backend-drive.ts'
import type { UnitLaunchRequest, UnitRun } from './unit-backend-types.ts'
import type { StopReason } from './process.ts'

export class UnitBackendLaunch extends UnitBackendDrive {
  // ---- launch ----------------------------------------------------------------------------------------------------

  launch(request: UnitLaunchRequest): UnitRun {
    const launchId = request.launchId ?? randomUUID()
    const ctl = new Control(launchId)
    const done = this.drive(launchId, request, ctl).catch((error: unknown) => {
      this.deps.onError?.(error)
      return this.outcomeOf(launchId, '', {
        refusal: `Could not start the supervised run: ${error instanceof Error ? error.message : String(error)}`,
        refusalCause: 'start_failed',
        stats: request.parser.stats,
      })
    })
    return { launchId, stop: (reason = 'user') => ctl.requestStop(reason, this), done }
  }

  /**
   * The first stop cause is saved before any signal goes out, so a Score that dies between the request and the end of
   * the run still knows why it stopped. It goes into the installation's journal first (an fsynced record outside the
   * restorable home; review 2026-10-12 #14) and into the database after it. The first cause wins. A failed write is
   * reported and the stop goes ahead: stopping matters more than the note.
   */
  recordStop(launchId: string, reason: StopReason): void {
    this.recordCause(launchId, STOP_CAUSE[reason])
  }
}
