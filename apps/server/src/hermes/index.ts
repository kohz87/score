import type { Config } from '../config.ts'
import { FakePort } from './fake/fake-port.ts'
import { LivePort } from './live/live-port.ts'
import type { HermesPort, HermesPortDeps } from './port.ts'

export type {
  HermesPort,
  HermesPortDeps,
  ObservationSink,
  ProviderBase,
  Scheduler,
} from './port.ts'
export {
  AgentFileConflictError,
  AgentFileNameSchema,
  EtagSchema,
  assertFileContent,
} from './agent-files.ts'
export { assertFeature } from './live/fingerprint.ts'
export { loadBridgeBootstrap } from './bridge/bootstrap.ts'
export { registerBridgeRoutes, type BridgeDeps } from './bridge/routes.ts'
export { getBridgeStatus } from './bridge/registry.ts'
export { sweepKanbanDenials } from './live/kanban-denials.ts'
export { pruneBridge } from './bridge/retention.ts'

export function createHermesPort(
  config: Pick<Config, 'mode' | 'fakeSpeed' | 'fakeLoop' | 'home' | 'hermesHome' | 'hermesUrl'>,
  deps: HermesPortDeps = {},
): HermesPort {
  return config.mode === 'fake'
    ? new FakePort(config.fakeSpeed, deps, config.fakeLoop)
    : new LivePort({
        ...deps,
        scoreHome: config.home,
        ...(config.hermesHome ? { hermesHome: config.hermesHome } : {}),
        ...(config.hermesUrl ? { baseUrl: config.hermesUrl } : {}),
      })
}

export { ApprovalDeliveryError } from './port.ts'
export {
  CreateRoutineSchema,
  CreateTaskSchema,
  PatchRoutineSchema,
  PatchTaskSchema,
  TaskFilterSchema,
  TaskActionRequestSchema,
  matchesTask,
} from './port.ts'
