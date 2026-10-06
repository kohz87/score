import type { Config } from '../config.ts'
import { FakePort } from './fake/fake-port.ts'
import { LivePort } from './live/live-port.ts'
import type { HermesPort, HermesPortDeps } from './port.ts'

export type { HermesPort, HermesPortDeps, ObservationSink, Scheduler } from './port.ts'

export function createHermesPort(
  config: Pick<Config, 'mode' | 'fakeSpeed'>,
  deps: HermesPortDeps = {},
): HermesPort {
  return config.mode === 'fake' ? new FakePort(config.fakeSpeed, deps) : new LivePort()
}
