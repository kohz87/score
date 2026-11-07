import type { FastifyInstance } from 'fastify'
import { sweepExpiredApprovals } from './domain/approval-expiry.ts'
import type { ApprovalOutbox } from './domain/approval-outbox.ts'
import { snapshotSessionCosts } from './domain/spend.ts'
import type { ScoreDb } from './db/index.ts'
import {
  kanbanAttemptsEnabled,
  pruneBridge,
  pruneKanbanAttempts,
  sweepKanbanDenials,
} from './hermes/index.ts'
import type { HermesPort } from './hermes/index.ts'
import type { Ingest } from './hub/ingest.ts'
import { pruneEvents } from './hub/retention.ts'
import { pruneAuxiliary } from './hub/retention-aux.ts'
import { retireIngestKeys, retireMedia } from './hub/retire.ts'
import { rotateLog } from './log-rotation.ts'
import { retryUntilResolved } from './retry-until-resolved.ts'
import { renewTailscaleCertificates } from './tls-names.ts'
import type { Config } from './config.ts'
import type { ServerLifecycle } from './start-server-lifecycle.ts'

export function startHoldRecovery(app: FastifyInstance, lifecycle: ServerLifecycle): void {
  // Only now can the adapter read tasks. Retried (bounded) while Hermes or a write keeps failing.
  const { recoverTaskHolds, recoverPlanStarts } = app
  const recoverHolds =
    recoverTaskHolds && recoverPlanStarts
      ? async () => (await recoverTaskHolds()) + (await recoverPlanStarts())
      : recoverTaskHolds
  if (recoverHolds) {
    // 20 fast passes (30 s apart), then every 5 minutes for as long as anything is unresolved.
    lifecycle.holdRecovery = retryUntilResolved(
      recoverHolds,
      [...Array<number>(20).fill(30_000), 300_000],
      {
        track: (job) => lifecycle.track(job),
      },
    )
  }
}

export function startBackgroundServices({
  config,
  app,
  db,
  ingest,
  outbox,
  port,
  lifecycle,
}: {
  config: Config
  app: FastifyInstance | undefined
  db: ScoreDb
  ingest: Ingest
  outbox: ApprovalOutbox
  port: HermesPort
  lifecycle: ServerLifecycle
}): void {
  lifecycle.deliverySweep = setInterval(() => {
    if (lifecycle.stopping) return
    if (config.mode === 'live' && !lifecycle.denialSweep) {
      lifecycle.denialSweep = sweepKanbanDenials(db, ingest, config)
        .catch(() => app?.log.error('Kanban denial sweep failed'))
        .finally(() => {
          lifecycle.denialSweep = undefined
        })
    }
    lifecycle.track(
      outbox
        .sweep()
        .catch((error: unknown) => app?.log.error({ err: error }, 'Delivery sweep failed')),
    )
  }, 10_000)
  lifecycle.deliverySweep.unref()
  lifecycle.retention = setInterval(
    () => {
      if (lifecycle.stopping) return
      try {
        pruneEvents(db)
      } catch (error) {
        app?.log.error({ err: error }, 'Event retention prune failed')
      }
      try {
        pruneAuxiliary(db)
      } catch (error) {
        app?.log.error({ err: error }, 'Auxiliary retention prune failed')
      }
      try {
        if (kanbanAttemptsEnabled()) pruneKanbanAttempts(db)
      } catch (error) {
        app?.log.error({ err: error }, 'Kanban attempts retention failed')
      }
      try {
        retireIngestKeys(db)
      } catch (error) {
        app?.log.error({ err: error }, 'Ingest key retirement failed')
      }
      try {
        if (app?.media) retireMedia(app.media)
      } catch (error) {
        app?.log.error({ err: error }, 'Media cleanup failed')
      }
      try {
        pruneBridge(db)
        lifecycle.track(
          sweepExpiredApprovals(db, ingest).catch((error: unknown) =>
            app?.log.error({ err: error }, 'Approval expiry failed'),
          ),
        )
      } catch (error) {
        app?.log.error({ err: error }, 'Bridge retention prune failed')
      }
    },
    60 * 60 * 1000,
  )
  lifecycle.retention.unref()
  const sampleSpend = () => {
    if (lifecycle.stopping) return
    lifecycle.track(
      snapshotSessionCosts(db, port, Date.now()).catch((error: unknown) =>
        app?.log.error({ err: error }, 'Spend snapshot failed'),
      ),
    )
  }
  lifecycle.spendSnapshots = setInterval(sampleSpend, 10 * 60 * 1000)
  lifecycle.spendSnapshots.unref()
  sampleSpend()
  if (config.remote?.tlsNamesDir)
    lifecycle.certificateRenewal = renewTailscaleCertificates(config.remote.tlsNamesDir, (error) =>
      app?.log.warn({ err: error }, 'Could not renew a Tailscale certificate'),
    )
  // The launcher names the file its output goes to; without it (tests, dev) nothing is rotated.
  const logFile = process.env.SCORE_LOG_FILE
  if (logFile) {
    lifecycle.logRotation = setInterval(() => {
      try {
        rotateLog(logFile)
      } catch (error) {
        app?.log.error({ err: error }, 'Log rotation failed')
      }
    }, 60_000)
    lifecycle.logRotation.unref()
  }
}
