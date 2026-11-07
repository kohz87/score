import type { AgentDetail } from '@score/contract'
import type { ScoreDb } from '../../db/index.ts'
import type { HermesPort, ObservationSink } from '../port.ts'
import { AcceptedBuilds } from './accepted-builds.ts'
import { LiveAgentTabs } from './agent-tabs.ts'
import { BotScreens } from './bot-screen.ts'
import { BotTakeovers } from './bot-takeover.ts'
import { cachingRunner } from './config-cache.ts'
import { createLiveConfigService } from './config.ts'
import { registerStoredKeys } from './credentials.ts'
import type { Fingerprint } from './fingerprint.ts'
import { GatewayClient } from './gateway.ts'
import { RunIntents } from './intents.ts'
import { installLivePortMethods, type LivePortPublicMethods } from './live-port-runtime.ts'
import type { LivePortOptions } from './live-port-types.ts'
import { LiveModels } from './models.ts'
import { resolveHermesHome } from './paths.ts'
import { ProfileFiles } from './profile-files.ts'
import { ProfileLocks } from './profile-locks.ts'
import { LiveProfileManagement } from './profile-management.ts'
import { ProfilesReader } from './profiles.ts'
import { LiveRoutines } from './routines.ts'
import { runHermes } from './cli.ts'
import { LiveSettings } from './settings.ts'
import { LiveTasks } from './tasks.ts'
import type { RunMetrics } from './translate.ts'

export { FIRST_STATUS_WAIT_MS } from './live-port-types.ts'
export type { LivePortOptions } from './live-port-types.ts'

const LivePortCore = class LivePort {
  readonly mode = 'live'
  readonly metrics: RunMetrics = { unknownEvents: 0 }
  private db: ScoreDb | undefined
  private gateway: GatewayClient | undefined
  private intents: RunIntents | undefined
  private sink: ObservationSink | undefined
  private controller: AbortController | undefined
  private timer: NodeJS.Timeout | undefined
  private taskTimer: NodeJS.Timeout | undefined
  private tasks: LiveTasks | undefined
  private refresh: Promise<void> | undefined
  private fingerprint: Fingerprint | undefined
  private fingerprintAt = -Infinity
  private readonly accepted: AcceptedBuilds
  private readonly followers = new Map<string, Promise<void>>()
  // 3.9.1 (owner: "codex agent keep showing offline when idle"): Score answers HTTP before the port has read which
  // profiles the gateway serves. An agent list asked for in that window would mark every idle Hermes agent offline, and
  // that answer is stored and pushed until something changes. Agent reads wait for the first status (bounded).
  private statusReady!: () => void
  private readonly firstStatus = new Promise<void>((resolve) => (this.statusReady = resolve))
  private current: ReturnType<HermesPort['status']> = {
    hermes: {
      version: null,
      reachable: false,
      apiServer: false,
      capabilities: [],
      servedProfiles: [],
    },
    bridge: { producers: 0, lastSeenAt: null, isolation: 'unknown' },
    compatibility: {
      fingerprint: 'unavailable',
      tested: false,
      disabled: ['gateway-approvals', 'score-runs'],
    },
    agentIsolation: 'same_user',
    degraded: ['Gateway status unavailable'],
  }
  private readonly profiles: ProfilesReader
  private readonly routines: LiveRoutines
  private readonly tabs: LiveAgentTabs
  private readonly settings: LiveSettings
  private readonly models = new LiveModels(
    async () => (await this.gateway?.modelOptions())?.providers ?? null,
  )
  private readonly config: ReturnType<typeof createLiveConfigService>
  private readonly locks = new ProfileLocks()
  private readonly profileFiles = new ProfileFiles()
  private readonly profileManagement: LiveProfileManagement
  private readonly options: LivePortOptions
  // One shared read-only RFB session per profile, opened while someone looks (decision 135).
  private readonly botProfileHome = (agentId: string) => {
    try {
      return this.profiles.profileHome(agentId)
    } catch {
      return null
    }
  }
  private readonly botScreens = new BotScreens({
    profileHome: this.botProfileHome,
    onLost: (agentId, control) => this.botTakeovers?.lost(agentId, control),
  })
  // 3.17.0: taking over a Bot Desktop through Hermes' lease, via Score's plugin in the profile's gateway.
  private botTakeoversValue: BotTakeovers | undefined
  private get botTakeovers(): BotTakeovers | undefined {
    if (!this.botTakeoversValue && this.options.db) {
      const broker = this.options.rewindBroker
      this.botTakeoversValue = new BotTakeovers({
        screens: this.botScreens,
        ask: broker ? (profile, req, timeoutMs) => broker.ask(profile, req, timeoutMs) : undefined,
        db: this.options.db,
        profileHome: this.botProfileHome,
      })
    }
    return this.botTakeoversValue
  }
  // Agents, Rooms and Now ask at once on a page load; on a cold cache each read starts several Hermes processes per
  // profile, so concurrent callers share one read (15 s per request after a restart, 2026-10-08 live).
  private agentDetailsFlight: Promise<AgentDetail[]> | undefined
  private agentDetailsFlightGeneration = 0
  /** When Score last asked Hermes to stop each run (3.7.2): a second Stop after the grace ends a run that never did. */
  private readonly stopAsked = new Map<string, number>()
  constructor(rawOptions: LivePortOptions) {
    // One cache in front of every config.yaml-derived read (config-cache.ts).
    const options: LivePortOptions = {
      ...rawOptions,
      runner: cachingRunner(
        rawOptions.runner ?? runHermes,
        resolveHermesHome(rawOptions.hermesHome),
      ),
    }
    this.options = options
    registerStoredKeys(options.scoreHome)
    this.accepted = new AcceptedBuilds(options.scoreHome)
    this.profiles = new ProfilesReader(resolveHermesHome(options.hermesHome), options.runner)
    this.routines = new LiveRoutines(options.hermesHome, options.runner)
    this.tabs = new LiveAgentTabs(
      resolveHermesHome(options.hermesHome),
      (profile) => this.profiles.profileHome(profile),
      (profile) => this.profiles.invalidate(profile),
      options.runner,
      this.locks,
    )
    this.settings = new LiveSettings(
      options.hermesHome,
      options.runner,
      async () => {
        const options = await this.gateway?.modelOptions()
        return options?.providers ?? null
      },
      options.settingsProfile,
      options.spawner,
      this.locks,
    )
    this.config = createLiveConfigService(options.hermesHome, options.runner, this.locks)
    this.profileManagement = new LiveProfileManagement({
      ...options,
      hermesHome: resolveHermesHome(options.hermesHome),
      db: options.db,
      profiles: this.profiles,
      port: this as unknown as HermesPort,
    })
  }
}

installLivePortMethods(LivePortCore.prototype)

export type LivePort = InstanceType<typeof LivePortCore> & LivePortPublicMethods & HermesPort

type LivePortConstructor = {
  new (rawOptions: LivePortOptions): LivePort
  readonly prototype: LivePort
}

export const LivePort = LivePortCore as unknown as LivePortConstructor
