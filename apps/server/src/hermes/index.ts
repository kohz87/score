import { ProfileNameSchema } from '@score/contract'
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
export { resolveHermesHome } from './live/paths.ts'
export { loadBridgeBootstrap } from './bridge/bootstrap.ts'
export {
  registerBridgeRoutes,
  registerBridgeCredentialGuard,
  type BridgeDeps,
} from './bridge/routes.ts'
export { getBridgeStatus } from './bridge/registry.ts'
export { sweepKanbanDenials } from './live/kanban-denials.ts'
export { createScreenshotImporter, type ScreenshotImporter } from './bridge/screenshots.ts'
export { pruneBridge } from './bridge/retention.ts'

export function createHermesPort(
  config: Pick<
    Config,
    | 'mode'
    | 'fakeSpeed'
    | 'fakeLoop'
    | 'home'
    | 'hermesHome'
    | 'hermesUrl'
    | 'bridgeInstallUrl'
    | 'bridgeInstallRef'
  >,
  deps: HermesPortDeps = {},
): HermesPort {
  // Dev/test only: aim the Settings provider routes at one profile (the live sign-in check uses a test profile).
  const settingsProfile = ProfileNameSchema.safeParse(process.env.SCORE_SETTINGS_PROFILE)
  return config.mode === 'fake'
    ? new FakePort(config.fakeSpeed, deps, config.fakeLoop, undefined, true)
    : new LivePort({
        ...deps,
        scoreHome: config.home,
        ...(config.hermesHome ? { hermesHome: config.hermesHome } : {}),
        ...(settingsProfile.success ? { settingsProfile: settingsProfile.data } : {}),
        ...(config.hermesUrl ? { baseUrl: config.hermesUrl } : {}),
        ...(config.bridgeInstallUrl ? { bridgeInstallUrl: config.bridgeInstallUrl } : {}),
        ...(config.bridgeInstallRef ? { bridgeInstallRef: config.bridgeInstallRef } : {}),
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
export { ALWAYS_BLOCKED_KEYS, KNOWN_PATTERN_KEYS } from './pattern-keys.ts'
export { ProfileInventorySchema, type ProfileStepContext } from './profile-management.ts'
