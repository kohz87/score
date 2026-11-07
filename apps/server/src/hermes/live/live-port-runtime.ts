import type { AgentDetail } from '@score/contract'
import type { ScoreDb } from '../../db/index.ts'
import type { HermesPort, ObservationSink } from '../port.ts'
import type { AcceptedBuilds } from './accepted-builds.ts'
import type { BotScreens } from './bot-screen.ts'
import type { BotTakeovers } from './bot-takeover.ts'
import type { createLiveConfigService } from './config.ts'
import type { Fingerprint } from './fingerprint.ts'
import type { GatewayClient } from './gateway.ts'
import type { RunIntents } from './intents.ts'
import type { LivePortOptions } from './live-port-types.ts'
import { type AgentMethods, agentMethods } from './live-port-agents.ts'
import { type LifecycleMethods, lifecycleMethods } from './live-port-lifecycle.ts'
import { type RunMethods, runMethods } from './live-port-runs.ts'
import { type SettingsMethods, settingsMethods } from './live-port-settings.ts'
import { type TaskMethods, taskMethods } from './live-port-tasks.ts'
import type { LiveAgentTabs } from './agent-tabs.ts'
import type { LiveModels } from './models.ts'
import type { ProfileFiles } from './profile-files.ts'
import type { ProfileLocks } from './profile-locks.ts'
import type { LiveProfileManagement } from './profile-management.ts'
import type { ProfilesReader } from './profiles.ts'
import type { LiveRoutines } from './routines.ts'
import type { LiveSettings } from './settings.ts'
import type { LiveTasks } from './tasks.ts'
import type { RunMetrics } from './translate.ts'

export interface LivePortRuntime
  extends LifecycleMethods, AgentMethods, SettingsMethods, RunMethods, TaskMethods {
  readonly mode: 'live'
  readonly metrics: RunMetrics
  db: ScoreDb | undefined
  gateway: GatewayClient | undefined
  intents: RunIntents | undefined
  sink: ObservationSink | undefined
  controller: AbortController | undefined
  timer: NodeJS.Timeout | undefined
  taskTimer: NodeJS.Timeout | undefined
  tasks: LiveTasks | undefined
  refresh: Promise<void> | undefined
  fingerprint: Fingerprint | undefined
  fingerprintAt: number
  accepted: AcceptedBuilds
  followers: Map<string, Promise<void>>
  statusReady: () => void
  firstStatus: Promise<void>
  current: ReturnType<HermesPort['status']>
  profiles: ProfilesReader
  routines: LiveRoutines
  tabs: LiveAgentTabs
  settings: LiveSettings
  models: LiveModels
  config: ReturnType<typeof createLiveConfigService>
  locks: ProfileLocks
  profileFiles: ProfileFiles
  profileManagement: LiveProfileManagement
  options: LivePortOptions
  botProfileHome: (agentId: string) => string | null
  botScreens: BotScreens
  botTakeoversValue: BotTakeovers | undefined
  readonly botTakeovers: BotTakeovers | undefined
  agentDetailsFlight: Promise<AgentDetail[]> | undefined
  agentDetailsFlightGeneration: number
  stopAsked: Map<string, number>
}

type WithoutThis<T> = T extends (this: LivePortRuntime, ...args: infer Args) => infer Result
  ? (...args: Args) => Result
  : never

type PublicMethods<T, K extends keyof T> = { [P in K]: WithoutThis<T[P]> }

export type LivePortPublicMethods = PublicMethods<
  LifecycleMethods,
  | 'start'
  | 'executionHold'
  | 'botScreenStatus'
  | 'botScreenFrame'
  | 'botScreenTake'
  | 'botScreenInput'
  | 'botScreenHeartbeat'
  | 'botScreenHandBack'
  | 'stop'
  | 'status'
> &
  PublicMethods<
    AgentMethods,
    | 'listAgents'
    | 'profileInventory'
    | 'profileExportPath'
    | 'profileStep'
    | 'describeProfile'
    | 'listAgentDetails'
    | 'listRoutines'
    | 'createRoutine'
    | 'patchRoutine'
    | 'deleteRoutine'
    | 'runRoutine'
    | 'setAgentModel'
    | 'readModelSettings'
    | 'updateModelSettings'
    | 'listSkills'
    | 'installSkill'
    | 'setSkillEnabled'
    | 'searchSkillHub'
    | 'readAgentTodos'
    | 'listAgentChannels'
    | 'listMemory'
    | 'addMemory'
    | 'deleteMemory'
    | 'readWorkspaceConfig'
    | 'setWorkspaceCwd'
    | 'readRunsOn'
    | 'setRunsOn'
    | 'setToolEnabled'
    | 'listPlugins'
    | 'setPluginEnabled'
    | 'interactiveCommand'
    | 'restartGateway'
    | 'readApprovals'
    | 'updateApprovals'
  > &
  PublicMethods<
    SettingsMethods,
    | 'listProviders'
    | 'listModels'
    | 'connectProvider'
    | 'getSignIn'
    | 'cancelSignIn'
    | 'addProviderKey'
    | 'addLocalProvider'
    | 'removeProvider'
    | 'removeToolServer'
    | 'removeMessaging'
    | 'listConnections'
    | 'addToolServer'
    | 'connectMessaging'
    | 'messagingFields'
    | 'saveMessaging'
    | 'checkHermes'
    | 'acceptHermes'
    | 'searchConfig'
    | 'previewConfig'
    | 'applyConfig'
    | 'readAgentFile'
    | 'writeAgentFile'
  > &
  PublicMethods<
    RunMethods,
    'startRun' | 'stopRun' | 'rewindSession' | 'compactSession' | 'sessionContext'
  > &
  PublicMethods<
    TaskMethods,
    | 'taskAction'
    | 'reportFacts'
    | 'journeyFacts'
    | 'listOutsideSessions'
    | 'readOutsideSession'
    | 'sessionContinuation'
    | 'sessionCosts'
    | 'listTasks'
    | 'getTask'
    | 'createTask'
    | 'patchTask'
    | 'answerQuestion'
    | 'deliverDecision'
  >

const livePortMethods = {
  ...lifecycleMethods,
  ...agentMethods,
  ...settingsMethods,
  ...runMethods,
  ...taskMethods,
}

/** Installs the live port's method modules on the class prototype with class-method descriptors. */
export function installLivePortMethods(prototype: object): void {
  for (const [name, method] of Object.entries(livePortMethods)) {
    Object.defineProperty(prototype, name, {
      value: method,
      writable: true,
      enumerable: false,
      configurable: true,
    })
  }
}
