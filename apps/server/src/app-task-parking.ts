import type { FastifyInstance } from 'fastify'
import type { Ingest } from './hub/ingest.ts'
import type { TaskHolds } from './http/task-holds.ts'
import type { HoldOwner } from './domain/holds.ts'

export function registerTaskHoldParking(
  app: FastifyInstance,
  ingest: Ingest,
  holds: TaskHolds,
  ownerPaused: (owner: HoldOwner) => boolean,
): void {
  // Tasks that arrive after a Pause get their pending hold in the observation's transaction (deriveBriefEvents);
  // this parks them once it commits. One pass at a time; a pass that finds more pending rows runs again.
  let parking: Promise<void> | undefined
  let retryTimer: NodeJS.Timeout | undefined
  let retries = 0
  const retryParking = () => {
    if (retryTimer) return
    retryTimer = setTimeout(
      () => {
        retryTimer = undefined
        void park()
      },
      Math.min(5_000 * 3 ** retries++, 300_000),
    )
    retryTimer.unref()
  }
  app.addHook('onClose', async () => clearTimeout(retryTimer))
  let again = false
  const park = (): Promise<void> => {
    if (parking) {
      again = true
      return parking
    }
    parking = (async () => {
      do {
        again = false
        const failed = await holds.applyPending(ownerPaused).catch(() => 1)
        // Unchanged tasks emit no upsert, so a failed park needs its own retry or it waits for the next event.
        if (failed > 0) retryParking()
        else retries = 0
      } while (again)
    })().finally(() => {
      parking = undefined
    })
    return parking
  }
  ingest.onCommitted((events) => {
    if (events.some((event) => event.type === 'task.upserted' || event.type === 'brief.upserted'))
      return park()
  })
}
