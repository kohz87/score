import type { SecureContextOptions, TlsOptions } from 'node:tls'
import type { FastifyServerOptions } from 'fastify'
import type { SystemStatus } from '@score/contract'
import type { Config } from './config.ts'
import type { SecurityPassword } from './auth/security-password.ts'
import type { ApprovalOutbox } from './domain/approval-outbox.ts'
import type { CodingRuntime } from './runtimes/coding/service.ts'
import type { KnowledgeVault } from './knowledge/vault.ts'
import type { MediaStore } from './media/store.ts'
import type { TerminalOptions } from './http/terminal.ts'
import type { TerminalManager } from './terminal/manager.ts'
import type { WebAssets } from './http/web-assets.ts'
import type { SessionStore } from './auth/session-store.ts'
import type { UpdateFetcher } from './domain/about.ts'
import type { StreamRouteOptions } from './http/stream.ts'
import type { ScoreDb } from './db/index.ts'
import type { Ingest } from './hub/ingest.ts'
import type { Orchestrator } from './domain/orchestration/executor.ts'
import type { PairingService } from './auth/pairing.ts'
import type { BridgeDeps, HermesPort } from './hermes/index.ts'

declare module 'fastify' {
  interface FastifyInstance {
    pairing: PairingService
    // Present when the app has a database; Watch frame capture stores screenshots with media.store().
    media?: MediaStore
    // Present when the app has a database. Resolves to the number of held tasks that still need another attempt.
    recoverTaskHolds?: () => Promise<number>
    recoverPlanStarts?: () => Promise<number>
    // Present only when the web terminal is on (SCORE_TERMINAL=1) and its native module loaded.
    terminals?: TerminalManager
  }
}

export interface BuildAppOptions {
  config: Config
  logger?: FastifyServerOptions['logger']
  clock?: () => number
  sessionStore?: SessionStore
  db?: ScoreDb
  ingest?: Ingest
  getEpoch?: () => string
  port?: HermesPort
  getSystemStatus?: () => SystemStatus
  /** The update check's network call; tests inject one so they never reach GitHub. */
  updateFetcher?: UpdateFetcher
  streamOptions?: Pick<StreamRouteOptions, 'heartbeatMs' | 'fanoutOptions'>
  bridge?: BridgeDeps
  outbox?: ApprovalOutbox
  media?: MediaStore
  /** The knowledge vault (started by the caller); without it the Knowledge routes are not served. */
  knowledge?: KnowledgeVault
  /** TLS options for the browser listener; `SNICallback` serves named certificates (tls-names.ts). */
  https?: SecureContextOptions & Pick<TlsOptions, 'SNICallback'>
  webAssets?: WebAssets
  /** Pairing-management password; defaults to one stored in the Score home when there is a database (a real server). */
  security?: SecurityPassword
  /** Coding agents (PLAN 7.2): Claude Code / Codex CLI as team members; without it there are none. */
  coding?: CodingRuntime
  /** The orchestration executor (PLAN 7.5a); without it the orchestration routes are not served. */
  orchestrator?: Orchestrator
  /** Test hooks for the web terminal: a stand-in PTY, a launch description, limits (the origins come from config). */
  terminal?: Pick<TerminalOptions, 'spawn' | 'launch' | 'limits' | 'clock' | 'isSecure'>
}
