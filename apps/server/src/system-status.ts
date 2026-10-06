import { SystemStatusSchema, type SystemStatus } from '@score/contract'
import type { Config } from './config.ts'

export function getSystemStatus(config: Config): SystemStatus {
  return SystemStatusSchema.parse({
    mode: config.mode,
    hermes: {
      version: null,
      reachable: false,
      apiServer: false,
      capabilities: [],
      servedProfiles: [],
    },
    bridge: { producers: 0, lastSeenAt: null, isolation: 'unknown' },
    compatibility: { fingerprint: 'unavailable', tested: false, disabled: [] },
    agentIsolation: 'same_user',
    degraded: ['Hermes adapter is not connected'],
  })
}
