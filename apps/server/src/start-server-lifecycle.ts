import { rmSync } from 'node:fs'
import type { Server } from 'node:net'
import type { FastifyInstance } from 'fastify'
import type { ApprovalOutbox } from './domain/approval-outbox.ts'
import type { Orchestrator } from './domain/orchestration/executor.ts'
import type { acquireHomeLock, ScoreDb } from './db/index.ts'
import type { HermesPort } from './hermes/index.ts'
import type { Ingest } from './hub/ingest.ts'
import type { KnowledgeVault } from './knowledge/vault.ts'
import type { CodingRuntime } from './runtimes/coding/service.ts'

interface DualServer {
  server: Server
  destroyConnections(): void
}

export class ServerLifecycle {
  app: FastifyInstance | undefined
  bridgeApp: FastifyInstance | undefined
  certificateRenewal: { stop(): void } | undefined
  coding: CodingRuntime | undefined
  db: ScoreDb | undefined
  deliverySweep: NodeJS.Timeout | undefined
  denialSweep: Promise<void> | undefined
  dualServer: DualServer | undefined
  fakeVaultDir: string | undefined
  guideApp: FastifyInstance | undefined
  holdRecovery: { stop(): Promise<void> } | undefined
  homeLock: ReturnType<typeof acquireHomeLock> | undefined
  ingest: Ingest | undefined
  knowledge: KnowledgeVault | undefined
  logRotation: NodeJS.Timeout | undefined
  orchestrator: Orchestrator | undefined
  outbox: ApprovalOutbox | undefined
  port: HermesPort | undefined
  retention: NodeJS.Timeout | undefined
  spendSnapshots: NodeJS.Timeout | undefined
  stopping = false
  private closing: Promise<void> | undefined
  // Background jobs that touch the database or the adapter after an await (samplers, sweeps). Shutdown stops new ones,
  // waits for these, and only then closes ingest and SQLite.
  private readonly jobs = new Set<Promise<unknown>>()

  track(job: Promise<unknown>): void {
    const settled = job.then(
      () => undefined,
      () => undefined,
    )
    this.jobs.add(settled)
    void settled.then(() => this.jobs.delete(settled))
  }

  private async drainJobs(): Promise<void> {
    while (this.jobs.size > 0) await Promise.all([...this.jobs])
  }

  private async closeResources(): Promise<void> {
    this.stopping = true
    clearInterval(this.retention)
    clearInterval(this.logRotation)
    this.certificateRenewal?.stop()
    // An attempt already awaiting the adapter is joined with the other jobs before ingest and SQLite close.
    if (this.holdRecovery) this.track(this.holdRecovery.stop())
    clearInterval(this.spendSnapshots)
    clearInterval(this.deliverySweep)
    try {
      await this.knowledge?.close()
      if (this.fakeVaultDir) rmSync(this.fakeVaultDir, { recursive: true, force: true })
    } catch {
      // best effort: the vault's files are the owner's and are never removed (only the fake mode's temp copy)
    }
    try {
      try {
        await this.orchestrator?.close()
        await this.coding?.close()
        await this.outbox?.stop()
      } finally {
        await this.denialSweep
        await this.port?.stop()
      }
    } finally {
      try {
        try {
          await this.bridgeApp?.close()
        } finally {
          // Stop accepting first, but wait for the sockets only after the apps dropped the connections they were
          // handed (open streams would otherwise hold the close forever).
          const listener = this.dualServer
          const stopped = listener?.server.listening
            ? new Promise<void>((resolve) => listener.server.close(() => resolve()))
            : undefined
          try {
            await this.app?.close()
          } finally {
            try {
              await this.guideApp?.close()
            } finally {
              listener?.destroyConnections()
              await stopped
            }
          }
        }
      } finally {
        try {
          await this.drainJobs()
          await this.ingest?.close()
          await this.drainJobs()
        } finally {
          this.closeDatabase()
        }
      }
    }
  }

  private closeDatabase(): void {
    try {
      this.db?.close()
    } finally {
      this.homeLock?.release()
    }
  }

  close(): Promise<void> {
    this.closing ??= this.closeResources()
    return this.closing
  }
}
