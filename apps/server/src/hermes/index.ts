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
    ? new FakePort(config.fakeSpeed, deps, config.fakeLoop, undefined, true)
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
export {
  AddMemorySchema,
  HubQuerySchema,
  InstallSkillSchema,
  MemoryIdSchema,
  MemoryQuerySchema,
  PatchSkillSchema,
  PatchToolSchema,
  SetModelSchema,
  SkillNameSchema,
  ToolIdSchema,
} from './agent-tabs.ts'
export {
  HubSkillSchema,
  MemoryItemSchema,
  MemoryPageSchema,
  SkillItemSchema,
  type HubSkill,
  type MemoryItem,
  type MemoryPage,
  type SkillItem,
} from '@score/contract'
export {
  NEVER_PREFIX,
  drifted,
  expectedConfig,
  goAheadRule,
  isKnownPatternKey,
  neverId,
  neverRule,
  patternLabel,
  type AgentOverrides,
  type ApprovalConfig,
  type Baseline,
} from './approvals.ts'
export { KNOWN_PATTERN_KEYS } from './pattern-keys.ts'
