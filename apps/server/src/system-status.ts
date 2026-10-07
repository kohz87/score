import { SystemStatusSchema, type SystemStatus } from '@score/contract'
import type { Config } from './config.ts'
import { createHermesPort, getBridgeStatus, type HermesPort } from './hermes/index.ts'
import type { ScoreDb } from './db/index.ts'

export function getSystemStatus(
  config: Config,
  port: HermesPort = createHermesPort(config),
  db?: ScoreDb,
  clock: () => number = Date.now,
): SystemStatus {
  return SystemStatusSchema.parse({
    mode: config.mode,
    ...port.status(),
    ...(config.mode === 'live' && db ? { bridge: getBridgeStatus(db.sqlite, clock()) } : {}),
  })
}
