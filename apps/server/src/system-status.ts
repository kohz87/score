import { SystemStatusSchema, type SystemStatus } from '@score/contract'
import type { Config } from './config.ts'
import { createHermesPort, type HermesPort } from './hermes/index.ts'

export function getSystemStatus(
  config: Config,
  port: HermesPort = createHermesPort(config),
): SystemStatus {
  return SystemStatusSchema.parse({
    mode: config.mode,
    ...port.status(),
  })
}
