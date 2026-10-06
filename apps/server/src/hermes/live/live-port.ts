import { HttpError } from '../../errors.ts'
import type { HermesPort } from '../port.ts'

const unavailable = 'Live Hermes adapter is not implemented yet'

function fail(): never {
  throw new HttpError(503, 'hermes_unavailable', unavailable)
}

export class LivePort implements HermesPort {
  readonly mode = 'live'

  async start(): Promise<never> {
    return fail()
  }

  async stop(): Promise<never> {
    return fail()
  }

  status(): ReturnType<HermesPort['status']> {
    return {
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
      degraded: [unavailable],
    }
  }

  async listAgents(): Promise<never> {
    return fail()
  }

  async startRun(): Promise<never> {
    return fail()
  }

  async stopRun(): Promise<never> {
    return fail()
  }

  async deliverDecision(): Promise<never> {
    return fail()
  }
}
