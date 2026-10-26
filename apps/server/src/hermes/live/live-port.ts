import { type AgentSummary, type HermesCheck, type ModelRef } from '@score/contract'
import { ProfilesReader, agentSummary } from './profiles.ts'
import { ProfileFiles } from './profile-files.ts'
import type { AgentFile, AgentFileName } from '../agent-files.ts'
import type { AgentDetail } from '@score/contract'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { ScoreDb } from '../../db/index.ts'
import type { MessagingSetupRequest, RunsOnUpdate } from '@score/contract'
import { HttpError } from '../../errors.ts'
import { assertThawed } from './freeze.ts'
import {
  projectedTasks,
  readProjectedTask,
  taskWithApproval,
  taskSummary,
} from '../../domain/tasks.ts'
import {
  ApprovalDeliveryError,
  DecisionDeliveryRequestSchema,
  TaskFilterSchema,
  matchesTask,
  type HermesPort,
  type HermesPortDeps,
  type ObservationSink,
  notDispatched,
} from '../port.ts'
import { CredentialsUnavailable, registerStoredKeys } from './credentials.ts'
import {
  assertFeature,
  computeFingerprint,
  evaluateCompatibility,
  testedFingerprints,
  type Fingerprint,
  type FingerprintInputs,
  type TestedFingerprint,
} from './fingerprint.ts'
import { LiveModels } from './models.ts'
import { AcceptedBuilds } from './accepted-builds.ts'
import { buildHermesCheck, type HermesCheckResult } from './hermes-check.ts'
import { hermesSourceDir, readSourceFacts, type SourceFacts } from './source-facts.ts'
import { KNOWN_PATTERN_KEYS } from '../pattern-keys.ts'
import { GatewayClient, HermesHttpError } from './gateway.ts'
import { RunIntents } from './intents.ts'
import { ProfileNameSchema, resolveHermesHome } from './paths.ts'
import { recoverRunOutput } from './recover.ts'
import { rewindSession } from './rewind.ts'
import { compactSession, sessionContext } from './compact.ts'
import { followRun, waitForRun, type FollowOptions } from './runs.ts'
import { taskAction, taskReader } from './task-actions.ts'
import { LiveTasks } from './tasks.ts'
import { readJourneyFacts } from './journey-facts.ts'
import { readProfileSessionCosts, readReportFacts } from './report-facts.ts'
import { listOutsideSessions, readOutsideSession, sessionRetired } from './outside-sessions.ts'
import { createTask, patchTask } from './task-writes.ts'
import { LiveRoutines } from './routines.ts'
import { LiveAgentTabs } from './agent-tabs.ts'
import { readAgentTodos } from './todos.ts'
import { MemoryIdSchema } from '../agent-tabs.ts'
import { ProfileLocks } from './profile-locks.ts'
import { createLiveConfigService } from './config.ts'
import { LiveSettings } from './settings.ts'
import { removeMessagingValues, saveMessagingValues } from './messaging.ts'
import { removeProviderAcross } from './remove-provider.ts'
import { messagingFields, messagingWrites } from '../messaging-fields.ts'
import { readApprovalConfig, updateProfileApprovals } from './approvals.ts'
import type { ApprovalConfig } from '../approvals.ts'
import { cachingRunner } from './config-cache.ts'
import { runHermes, type HermesRunner, type HermesSpawner } from './cli.ts'
import { readRun, RunRowSchema, runLifecycle, type RunMetrics } from './translate.ts'
import { LiveProfileManagement } from './profile-management.ts'
import { BotScreens } from './bot-screen.ts'
import { assertAgentAdmits } from '../../domain/agent-lifecycle.ts'
import { assertNotKanbanAttempt } from '../../domain/kanban-attempts.ts'

const StateSchema = z.object({ served_profiles: z.array(ProfileNameSchema) })
export interface LivePortOptions extends HermesPortDeps {
  bridgeInstallUrl?: string
  bridgeInstallRef?: string
  scoreHome: string
  hermesHome?: string
  baseUrl?: string
  db?: ScoreDb
  runner?: HermesRunner
  spawner?: HermesSpawner
  /** Profile the provider routes act on (dev/tests only; default: Hermes's default profile). */
  settingsProfile?: string
  fetch?: typeof globalThis.fetch
  readCliVersion?: FingerprintInputs['readCliVersion']
  testedFingerprints?: readonly TestedFingerprint[]
  /** Reads what Score relies on from the Hermes sources; tests inject fixtures. */
  readSourceFacts?: (sourceDir: string) => Promise<SourceFacts | null>
  following?: Pick<FollowOptions, 'backoff' | 'pollIntervalMs' | 'pollLimitMs' | 'now' | 'wait'>
}
export class LivePort implements HermesPort {
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
      port: this,
    })
  }

  async start(sink: ObservationSink): Promise<void> {
    if (this.sink) return
    if (!this.options.db) throw new Error('The live Hermes port needs the shared Score DB')
    this.db = this.options.db
    try {
      this.gateway = new GatewayClient({
        scoreHome: this.options.scoreHome,
        db: this.db,
        ...(this.options.baseUrl ? { baseUrl: this.options.baseUrl } : {}),
        ...(this.options.fetch ? { fetch: this.options.fetch } : {}),
      })
      this.controller = new AbortController()
      this.sink = sink
      this.tasks = new LiveTasks(this.db, sink, this.options.hermesHome)
      await this.tasks.poll().catch((error: unknown) => this.options.onError?.(error))
      this.taskTimer = setInterval(() => {
        void this.tasks?.poll().catch((error: unknown) => this.options.onError?.(error))
      }, 1000)
      this.taskTimer.unref()
      this.intents = new RunIntents({
        db: this.db,
        gateway: this.gateway,
        sink,
        ...(this.options.imageReader ? { imageReader: this.options.imageReader } : {}),
        ...(this.options.frozen ? { frozen: this.options.frozen } : {}),
      })
      await this.refreshStatus()
      await this.intents.recoverIntents()
      const rows = z
        .array(RunRowSchema)
        .parse(
          this.db.sqlite
            .prepare(
              `SELECT * FROM runs WHERE origin = 'score' AND runtime = 'hermes' AND status IN ('queued','running','waiting_for_approval')`,
            )
            .all(),
        )
      for (const row of rows) this.follow(row.id)
      this.timer = setInterval(() => {
        void this.refreshStatus()
      }, 30_000)
      this.timer.unref()
    } catch (error) {
      await this.stop()
      throw error
    }
  }
  /** Why Score holds all agent work, or null (decision 72). The chat dispatcher asks before it pumps. */
  executionHold(): string | null {
    return this.options.frozen?.() ?? null
  }
  // One shared read-only RFB session per profile, opened while someone looks (decision 135).
  private readonly botScreens = new BotScreens({
    profileHome: (agentId) => {
      try {
        return this.profiles.profileHome(agentId)
      } catch {
        return null
      }
    },
  })
  botScreenStatus(agentId: string) {
    return this.botScreens.status(agentId)
  }
  botScreenFrame(agentId: string) {
    return this.botScreens.frame(agentId)
  }
  async stop(): Promise<void> {
    this.botScreens.close()
    this.settings.close()
    clearInterval(this.timer)
    clearInterval(this.taskTimer)
    this.controller?.abort()
    await this.tasks?.close()
    this.tasks = undefined
    await this.intents?.drain()
    await Promise.allSettled([...this.followers.values()])
    await this.refresh
    this.followers.clear()
    this.sink = undefined
    this.intents = undefined
    this.gateway = undefined
    this.db = undefined
    this.fingerprint = undefined
  }
  status(): ReturnType<HermesPort['status']> {
    return structuredClone(this.current)
  }

  private refreshStatus(): Promise<void> {
    if (this.refresh) return this.refresh
    this.refresh = this.loadStatus().finally(() => {
      this.refresh = undefined
    })
    return this.refresh
  }
  private async loadStatus(): Promise<void> {
    const degraded: string[] = []
    let served: string[] = []
    try {
      served = StateSchema.parse(
        JSON.parse(
          readFileSync(
            join(resolveHermesHome(this.options.hermesHome), 'gateway_state.json'),
            'utf8',
          ),
        ),
      ).served_profiles
    } catch {
      degraded.push('Served profiles unavailable')
    }
    let reachable = false
    let version: string | null = null
    try {
      const health = await this.gateway!.health()
      reachable = health.status === 'ok'
      version = health.version
    } catch {
      degraded.push('Gateway unreachable')
    }
    const capabilities = new Set<string>()
    let defaultCapabilities: string[] | null = null
    for (const profile of new Set(['default', ...served])) {
      try {
        const features = await this.gateway!.capabilities(profile)
        if (profile === 'default')
          defaultCapabilities = Object.keys(features).filter((name) => features[name] === true)
        for (const [feature, enabled] of Object.entries(features))
          if (enabled === true) capabilities.add(feature)
      } catch (error) {
        degraded.push(
          error instanceof CredentialsUnavailable
            ? `${profile}: credentials unavailable`
            : `${profile}: capabilities unavailable`,
        )
      }
    }
    if (
      !this.fingerprint ||
      Date.now() - this.fingerprintAt >= 10 * 60_000 ||
      (reachable && !this.current.hermes.reachable)
    ) {
      this.fingerprint = await computeFingerprint({
        ...(this.options.hermesHome ? { hermesHome: this.options.hermesHome } : {}),
        capabilities: defaultCapabilities,
        ...(this.options.readCliVersion ? { readCliVersion: this.options.readCliVersion } : {}),
      })
      this.fingerprintAt = Date.now()
    }
    const compatibility = evaluateCompatibility(this.fingerprint, this.testedBuilds())
    if (!compatibility.tested) {
      const { codeVersion, codeSha } = this.fingerprint.parts
      degraded.push(
        `Untested Hermes build: ${codeVersion ?? 'unknown'} (${codeSha?.slice(0, 8) ?? 'unknown'})`,
      )
    }
    this.current = {
      ...this.current,
      hermes: {
        version,
        reachable,
        apiServer: reachable,
        capabilities: [...capabilities].sort(),
        servedProfiles: served,
      },
      compatibility,
      degraded,
    }
  }
  async listAgents(): Promise<AgentSummary[]> {
    return (await this.listAgentDetails()).map(agentSummary)
  }
  profileInventory(name: string, cloneFrom?: string) {
    return this.profileManagement.profileInventory(name, cloneFrom)
  }
  profileExportPath(name: string, revision: string) {
    return this.profileManagement.profileExportPath(name, revision)
  }
  profileStep(...args: Parameters<HermesPort['profileStep']>) {
    return this.profileManagement.profileStep(...args)
  }
  describeProfile(name: string, description: string) {
    return this.profileManagement.describeProfile(name, description)
  }
  // Agents, Rooms and Now ask at once on a page load; on a cold cache each read starts several Hermes processes per
  // profile, so concurrent callers share one read (15 s per request after a restart, 2026-10-08 live).
  private agentDetailsFlight: Promise<AgentDetail[]> | undefined
  private agentDetailsFlightGeneration = 0
  listAgentDetails(): Promise<AgentDetail[]> {
    // A read that began before Score changed a profile's settings must not answer a caller that asked after.
    if (
      this.agentDetailsFlight &&
      this.agentDetailsFlightGeneration !== this.profiles.invalidations
    )
      this.agentDetailsFlight = undefined
    if (!this.agentDetailsFlight) {
      this.agentDetailsFlightGeneration = this.profiles.invalidations
      const mine = this.readAgentDetails().finally(() => {
        if (this.agentDetailsFlight === mine) this.agentDetailsFlight = undefined
      })
      this.agentDetailsFlight = mine
    }
    return this.agentDetailsFlight.then((details) => structuredClone(details))
  }
  private async readAgentDetails(): Promise<AgentDetail[]> {
    const served = this.current.hermes.servedProfiles
    const names = this.profiles.names(served)
    return Promise.all(
      names.map((profile, index) => {
        const active = (this.db ?? this.options.db)?.sqlite
          .prepare(
            `SELECT * FROM runs WHERE profile = ? AND status IN ('queued','running','waiting_for_approval') ORDER BY started_at DESC LIMIT 1`,
          )
          .get(profile)
        const row = active === undefined ? undefined : RunRowSchema.parse(active)
        return this.profiles.read(profile, index, served.includes(profile), {
          status:
            row?.status === 'waiting_for_approval'
              ? 'waiting'
              : row
                ? 'working'
                : served.includes(profile)
                  ? 'idle'
                  : 'offline',
          activity: row ? 'Running a turn' : null,
        })
      }),
    )
  }
  async listRoutines(agentId: string) {
    return this.routines.list(agentId)
  }
  async createRoutine(
    agentId: string,
    req: Parameters<HermesPort['createRoutine']>[1],
    key: string,
  ) {
    const { db } = this.requireStarted()
    return this.routines.create(agentId, req, key, db)
  }
  async patchRoutine(id: string, req: Parameters<HermesPort['patchRoutine']>[1]) {
    this.requireStarted()
    return this.routines.patch(id, req)
  }
  async deleteRoutine(id: string) {
    this.requireStarted()
    await this.routines.remove(id)
  }
  async runRoutine(id: string) {
    // A routine run is an agent turn: refused like every other outgoing execution while Score holds all agent work.
    assertThawed(this.options.frozen)
    this.requireStarted()
    await this.routines.run(id)
  }
  async setAgentModel(agentId: string, req: Parameters<HermesPort['setAgentModel']>[1]) {
    this.requireStarted()
    await this.tabs.setModel(agentId, req)
  }
  async readModelSettings(agentId: string) {
    this.requireStarted()
    return this.tabs.getModelSettings(agentId)
  }
  async updateModelSettings(
    agentId: string,
    req: Parameters<HermesPort['updateModelSettings']>[1],
  ) {
    this.requireStarted()
    return this.tabs.updateModelSettings(agentId, req)
  }
  async listSkills(agentId: string) {
    return this.tabs.listSkills(agentId)
  }
  async installSkill(agentId: string, identifier: string) {
    this.requireStarted()
    return this.tabs.installSkill(agentId, { name: identifier })
  }
  async setSkillEnabled(agentId: string, name: string, enabled: boolean) {
    this.requireStarted()
    return this.tabs.setSkillEnabled(agentId, name, enabled)
  }
  async searchSkillHub(query: string) {
    return this.tabs.searchHub(query)
  }
  async readAgentTodos(agentId: string) {
    return readAgentTodos(agentId, resolveHermesHome(this.options.hermesHome))
  }
  async listAgentChannels(agentId: string) {
    return this.tabs.listChannels(agentId)
  }
  async listMemory(agentId: string, query: Parameters<HermesPort['listMemory']>[1]) {
    return this.tabs.listMemory(agentId, query)
  }
  async addMemory(agentId: string): Promise<never> {
    return this.tabs.unsupportedMemoryWrite(agentId)
  }
  async deleteMemory(agentId: string, id: string): Promise<never> {
    MemoryIdSchema.parse(id)
    return this.tabs.unsupportedMemoryWrite(agentId)
  }
  async readWorkspaceConfig(agentId: string) {
    return this.tabs.readWorkspaceConfig(agentId)
  }
  async setWorkspaceCwd(agentId: string, cwd: string) {
    this.requireStarted()
    return this.tabs.setWorkspaceCwd(agentId, cwd)
  }
  async readRunsOn(agentId: string) {
    return this.tabs.readRunsOn(agentId)
  }
  async setRunsOn(agentId: string, update: RunsOnUpdate) {
    this.requireStarted()
    return this.tabs.setRunsOn(agentId, update)
  }
  async setToolEnabled(agentId: string, toolId: string, enabled: boolean) {
    this.requireStarted()
    return this.tabs.setToolEnabled(agentId, toolId, enabled)
  }
  async listPlugins(agentId: string) {
    this.requireStarted()
    return this.tabs.listPlugins(agentId)
  }
  async setPluginEnabled(agentId: string, id: string, enabled: boolean) {
    this.requireStarted()
    return this.tabs.setPluginEnabled(agentId, id, enabled)
  }
  private approvalProfile(agentId: string): string {
    const parsed = ProfileNameSchema.safeParse(agentId)
    if (!parsed.success || !this.profiles.profileHome(parsed.data))
      throw new HttpError(404, 'not_found', 'Couldn’t find that agent.')
    return parsed.data
  }
  async readApprovals(agentId: string): Promise<ApprovalConfig> {
    return readApprovalConfig(
      this.options.runner ?? runHermes,
      resolveHermesHome(this.options.hermesHome),
      this.approvalProfile(agentId),
    )
  }
  // Writers within this process share the profile's queue; Hermes itself is the only other writer left to merge with.
  updateApprovals(
    agentId: string,
    edit: (current: ApprovalConfig) => ApprovalConfig,
  ): Promise<ApprovalConfig> {
    const profile = this.approvalProfile(agentId)
    return this.locks.run(profile, () =>
      updateProfileApprovals(
        this.options.runner ?? runHermes,
        resolveHermesHome(this.options.hermesHome),
        profile,
        edit,
      ).finally(() => this.profiles.invalidate(profile)),
    )
  }
  async listProviders() {
    return this.settings.listProviders()
  }
  async listModels(q?: string, only?: readonly ModelRef[], limit?: number) {
    return this.models.list(q, only, limit)
  }
  async connectProvider(id: string) {
    return this.settings.connectProvider(id)
  }
  async getSignIn(id: string) {
    return this.settings.getSignIn(id)
  }
  async cancelSignIn(id: string) {
    return this.settings.cancelSignIn(id)
  }
  async addProviderKey(id: string, req: Parameters<HermesPort['addProviderKey']>[1]) {
    // A local provider's key goes into every profile that defines it (2.0.10); a hosted one through `auth add`. Local
    // is what the provider list says (an item with `keySet`), not merely a `providers.<id>` entry somewhere, which can
    // be an override of a hosted provider.
    // A failed read must not look like "not local": the key would go down the hosted path.
    const localIds = await this.settings.localProviderIds()
    if (localIds === null)
      throw new HttpError(
        502,
        'hermes_unavailable',
        'Couldn’t read the providers, so the key wasn’t saved. Try again.',
      )
    if (!localIds.has(id)) return this.settings.addProviderKey(id, req)
    const profiles = this.profiles.names(this.current.hermes.servedProfiles)
    const answers = await Promise.all(
      profiles.map((profile) => this.tabs.definesLocalProvider(profile, id).catch(() => null)),
    )
    // An unreadable profile might hold a copy that would miss the key: stop rather than guess.
    if (answers.some((answer) => answer === null))
      throw new HttpError(
        502,
        'hermes_unavailable',
        'Couldn’t read every agent’s providers, so the key wasn’t saved. Try again.',
      )
    const local = profiles.filter((_, at) => answers[at] === true)
    if (local.length === 0) throw new HttpError(404, 'not_found', 'Couldn’t find that provider.')
    for (const profile of local) await this.tabs.setLocalProviderKey(profile, id, req.apiKey)
    this.profiles.invalidate(this.options.settingsProfile ?? 'default')
    const item = (await this.settings.listProviders()).find((provider) => provider.id === id)
    if (!item) throw new HttpError(404, 'not_found', 'Couldn’t find that provider.')
    return item
  }
  async addLocalProvider(req: Parameters<HermesPort['addLocalProvider']>[0]) {
    const provider = await this.settings.addLocalProvider(req)
    // Every agent can use it (2.0.3). A copy that fails here is made again when an agent picks the provider's model;
    // the key (2.0.10) is written to each copy right away, since Hermes masks it and it can't be copied later.
    const source = this.options.settingsProfile ?? 'default'
    await Promise.all(
      this.profiles
        .names(this.current.hermes.servedProfiles)
        .filter((profile) => profile !== source)
        .map(async (profile) => {
          try {
            await this.tabs.copyLocalProvider(
              profile,
              provider.id,
              source,
              req.apiKey !== undefined,
            )
            if (req.apiKey !== undefined)
              await this.tabs.setLocalProviderKey(profile, provider.id, req.apiKey)
          } catch {
            /* made again when an agent picks the model; a missing key then says so */
          }
        }),
    )
    return provider
  }
  // A race with a model change that picks this provider between the route's in-use check and here is accepted: one
  // person drives Score, and the agent's next turn would say its provider is gone.
  async removeProvider(id: string) {
    const settingsProfile = this.options.settingsProfile ?? 'default'
    try {
      await removeProviderAcross(id, {
        profiles: this.profiles.names(this.current.hermes.servedProfiles),
        defines: (profile, provider) => this.tabs.definesLocalProvider(profile, provider),
        removeLocal: (profile, provider) => this.tabs.removeLocalProvider(profile, provider),
        removeHosted: (provider) => this.settings.removeHostedProvider(provider),
      })
    } finally {
      this.profiles.invalidate(settingsProfile)
    }
  }
  async removeToolServer(id: string) {
    try {
      await this.settings.removeToolServer(id)
    } finally {
      this.profiles.invalidate(this.options.settingsProfile ?? 'default')
    }
  }
  async removeMessaging(platform: string, agentId?: string) {
    const { fields, browserSetup } = messagingFields(platform)
    if (!browserSetup)
      throw new HttpError(
        409,
        'not_supported',
        'Remove this one in the terminal: hermes gateway setup.',
      )
    let profile = this.options.settingsProfile
    if (agentId !== undefined) {
      const parsed = ProfileNameSchema.safeParse(agentId)
      if (!parsed.success || !this.profiles.profileHome(parsed.data))
        throw new HttpError(404, 'not_found', 'Couldn’t find that agent.')
      profile = parsed.data
    }
    return removeMessagingValues({
      hermesHome: resolveHermesHome(this.options.hermesHome),
      profile,
      platform,
      keys: fields.map((field) => field.key),
      runner: this.options.runner,
      locks: this.locks,
      invalidate: () => profile && this.profiles.invalidate(profile),
    })
  }
  async listConnections() {
    return this.settings.listConnections()
  }
  async addToolServer(req: Parameters<HermesPort['addToolServer']>[0]) {
    return this.settings.addToolServer(req)
  }
  async connectMessaging(platform: string) {
    return this.settings.connectMessaging(platform)
  }
  async messagingFields(platform: string) {
    return messagingFields(platform)
  }
  async saveMessaging(platform: string, req: MessagingSetupRequest) {
    const writes = messagingWrites(platform, req.values)
    let profile = this.options.settingsProfile
    if (req.agentId !== undefined) {
      const parsed = ProfileNameSchema.safeParse(req.agentId)
      if (!parsed.success || !this.profiles.profileHome(parsed.data))
        throw new HttpError(404, 'not_found', 'Couldn’t find that agent.')
      profile = parsed.data
    }
    return saveMessagingValues({
      hermesHome: resolveHermesHome(this.options.hermesHome),
      profile,
      platform,
      writes,
      runner: this.options.runner,
      locks: this.locks,
      invalidate: () => profile && this.profiles.invalidate(profile),
    })
  }
  private testedBuilds(): TestedFingerprint[] {
    return [...(this.options.testedFingerprints ?? testedFingerprints), ...this.accepted.tested()]
  }
  private async runHermesCheck(): Promise<HermesCheckResult & { fingerprint: Fingerprint }> {
    const home = resolveHermesHome(this.options.hermesHome)
    const fingerprint = await computeFingerprint({
      hermesHome: home,
      ...(this.gateway ? { gateway: this.gateway } : {}),
      ...(this.options.readCliVersion ? { readCliVersion: this.options.readCliVersion } : {}),
    })
    const facts = await (this.options.readSourceFacts ?? readSourceFacts)(hermesSourceDir(home))
    const result = buildHermesCheck({
      fingerprint,
      facts,
      tested: this.testedBuilds(),
      knownPatternKeys: [...KNOWN_PATTERN_KEYS, ...this.accepted.patternKeys()],
    })
    return { ...result, fingerprint }
  }
  async checkHermes(): Promise<HermesCheck> {
    return (await this.runHermesCheck()).check
  }
  async acceptHermes(hash: string): Promise<void> {
    const { check, fingerprint, addedPatternKeys } = await this.runHermesCheck()
    if (check.hash !== hash)
      throw new HttpError(409, 'conflict', 'Hermes changed since it was checked. Check it again.')
    if (!check.compatible)
      throw new HttpError(
        409,
        'not_compatible',
        'This Hermes build changed in ways Score can’t accept.',
      )
    this.accepted.add({
      id: fingerprint.id,
      parts: fingerprint.parts,
      testedAt: new Date().toISOString(),
      notes: 'Accepted in Settings after the Hermes version check.',
      addedPatternKeys,
    })
    this.fingerprint = fingerprint
    this.fingerprintAt = Date.now()
    await this.refresh
    await this.refreshStatus()
  }
  async searchConfig(query: string) {
    return this.config.search(query)
  }
  async previewConfig(changes: Parameters<HermesPort['previewConfig']>[0]) {
    return this.config.preview(changes)
  }
  async applyConfig(req: Parameters<HermesPort['applyConfig']>[0]) {
    return this.config.apply(req)
  }
  private agentHome(agentId: string): string {
    const parsed = ProfileNameSchema.safeParse(agentId)
    const home = parsed.success ? this.profiles.profileHome(parsed.data) : null
    if (!home) throw new HttpError(404, 'not_found', 'Couldn’t find that agent.')
    return home
  }
  async readAgentFile(agentId: string, file: AgentFileName): Promise<AgentFile> {
    return this.profileFiles.read(this.agentHome(agentId), file)
  }
  async writeAgentFile(
    agentId: string,
    file: AgentFileName,
    content: string,
    etag: string,
  ): Promise<{ etag: string }> {
    return this.profileFiles.write(this.agentHome(agentId), file, content, etag)
  }
  private requireStarted() {
    if (
      !this.db ||
      !this.gateway ||
      !this.intents ||
      !this.sink ||
      !this.controller ||
      this.controller.signal.aborted
    )
      throw new HttpError(
        503,
        'hermes_unavailable',
        'Score isn’t connected to Hermes yet. Try again in a moment.',
      )
    return {
      db: this.db,
      gateway: this.gateway,
      intents: this.intents,
      sink: this.sink,
      signal: this.controller.signal,
    }
  }
  private follow(runId: string): void {
    if (this.followers.has(runId) || this.controller?.signal.aborted || !this.sink) return
    const { db, gateway, sink, signal } = this.requireStarted()
    const row = readRun(db.sqlite, runId)
    if (runLifecycle.isTerminal(row.status) || row.credential_generation === null) return
    const pending = (async () => {
      let attempts = 0
      while (!signal.aborted && !runLifecycle.isTerminal(readRun(db.sqlite, runId).status)) {
        try {
          await followRun({
            db,
            gateway,
            sink,
            signal,
            context: {
              profile: row.profile,
              runId,
              credentialGeneration: row.credential_generation!,
              getDisabled: () => this.current.compatibility.disabled,
            },
            metrics: this.metrics,
            recoverOutput: (request) => recoverRunOutput(request, this.options.hermesHome),
            ...this.options.following,
          })
        } catch (error) {
          if (error instanceof CredentialsUnavailable)
            this.current.degraded.push(`${row.profile}: credentials unavailable`)
          this.options.onError?.(error)
        }
        if (signal.aborted || runLifecycle.isTerminal(readRun(db.sqlite, runId).status)) break
        await (this.options.following?.wait ?? waitForRun)(
          [60_000, 300_000, 900_000][Math.min(attempts++, 2)]!,
          signal,
        )
      }
    })().finally(() => this.followers.delete(runId))
    this.followers.set(runId, pending)
  }
  async startRun(req: {
    agentId: string
    input: string
    turnId: string
    sessionId?: string
    model?: string
    provider?: string
    images?: string[]
    owner?: 'orchestration'
    render?: (stored: string) => string
  }): Promise<{ runId: string }> {
    let intents: RunIntents
    try {
      ;({ intents } = this.requireStarted())
      assertThawed(this.options.frozen)
      assertAgentAdmits(this.db!.sqlite, req.agentId)
      assertFeature(this.current, 'score-runs')
      if (!this.current.hermes.servedProfiles.includes(req.agentId))
        throw new HttpError(503, 'hermes_unavailable', 'This agent’s gateway isn’t running.')
    } catch (error) {
      // Nothing was sent: the orchestrator may conclude "not dispatched" from this.
      throw notDispatched(error)
    }
    const result = await intents
      .startRunIntent(
        {
          profile: req.agentId,
          input: req.input,
          ...(req.model ? { model: req.model } : {}),
          ...(req.provider ? { provider: req.provider } : {}),
          ...(req.sessionId ? { sessionId: req.sessionId } : {}),
          ...(req.images?.length ? { images: req.images } : {}),
        },
        req.turnId,
        {
          ...(typeof req.owner === 'string' ? { owner: req.owner } : {}),
          ...(req.render ? { render: req.render } : {}),
        },
      )
      .catch((error: unknown) => {
        // The session was deleted in Hermes (decision 128): routing moves the agent to a successor session.
        // Hermes answers a run into a retired id with a plain 409 (`not_found` from its admission lookup), so the
        // retirement itself is checked in its state database.
        if (
          error instanceof HermesHttpError &&
          error.status === 409 &&
          req.sessionId &&
          (error.code === 'session_deleted' ||
            sessionRetired(req.agentId, req.sessionId, this.options.hermesHome))
        )
          throw new HttpError(409, 'session_deleted', 'Hermes deleted this conversation.')
        // A definite refusal (4xx other than timeout/conflict/rate limit) is permanent: surface it as an
        // HttpError so the caller fails the turn instead of retrying it forever.
        if (
          error instanceof HermesHttpError &&
          error.status >= 400 &&
          error.status < 500 &&
          ![408, 409, 429].includes(error.status)
        )
          throw new HttpError(422, error.code, 'Hermes refused this run.')
        throw error
      })
    this.follow(result.runId)
    return result
  }
  async stopRun(req: { agentId: string; runId: string }): Promise<void> {
    // Kanban attempts are not runs and cannot be stopped from Score: refused before any profile or run lookup.
    assertNotKanbanAttempt(req.runId)
    // Any Stop (a message's, a Flow's, a person's) can name a run that belongs to another installation (decision 72).
    assertThawed(this.options.frozen)
    const { db, gateway } = this.requireStarted()
    const row = readRun(db.sqlite, req.runId)
    if (row.profile !== req.agentId)
      throw new HttpError(404, 'not_found', 'Couldn’t find that run.')
    await gateway.stopRun(req.agentId, req.runId, row.credential_generation ?? undefined)
  }
  rewindSession(req: Parameters<HermesPort['rewindSession']>[0]) {
    return rewindSession(req, {
      broker: this.options.rewindBroker,
      ...(this.options.hermesHome ? { hermesHome: this.options.hermesHome } : {}),
    })
  }
  compactSession(req: { agentId: string; sessionId: string; keepRecent?: number }) {
    return compactSession(req, {
      broker: this.options.rewindBroker,
      ...(this.options.hermesHome ? { hermesHome: this.options.hermesHome } : {}),
    })
  }
  sessionContext(req: { agentId: string; sessionId: string }) {
    return sessionContext(req, {
      broker: this.options.rewindBroker,
      ...(this.options.hermesHome ? { hermesHome: this.options.hermesHome } : {}),
    })
  }
  async taskAction(
    req: Parameters<HermesPort['taskAction']>[0],
  ): Promise<{ hermesStatus: string }> {
    // Actions that make Hermes pick a task up (start, unblock, schedule, ask for review or changes) start agent work.
    if (['start', 'unblock', 'schedule', 'request_review', 'request_changes'].includes(req.action))
      assertThawed(this.options.frozen)
    const { gateway } = this.requireStarted()
    const result = await taskAction(req, {
      readTask: taskReader(this.options.hermesHome),
      withoutCredential: (profile, text) => {
        try {
          return gateway.withoutCredential(profile, text)
        } catch (error) {
          if (error instanceof CredentialsUnavailable) return text
          throw error
        }
      },
      ...(this.options.runner ? { runner: this.options.runner } : {}),
      ...(this.options.hermesHome ? { hermesHome: this.options.hermesHome } : {}),
    })
    await this.refreshTasks()
    return result
  }
  async reportFacts(req: Parameters<HermesPort['reportFacts']>[0]) {
    return readReportFacts(req, this.options.hermesHome)
  }
  async journeyFacts(req: Parameters<HermesPort['journeyFacts']>[0]) {
    return readJourneyFacts(
      req,
      (profile) => this.profiles.profileHome(profile),
      this.options.hermesHome,
    )
  }
  async listOutsideSessions(agentIds: string[]) {
    return listOutsideSessions(agentIds, this.options.hermesHome)
  }
  async readOutsideSession(agentId: string, sessionId: string) {
    return readOutsideSession(agentId, sessionId, this.options.hermesHome)
  }
  // Hermes' /v1/runs takes `session_id` and loads that session's history (api_server_runs.py); Score already passes
  // one on every run. A gateway without the run API cannot start Score runs at all.
  sessionContinuation(): 'same_session' | 'new_session' | 'unknown' {
    // An unreachable gateway says nothing about what it supports: never turn an outage into a stored fallback.
    return this.current.hermes.reachable && this.current.hermes.apiServer
      ? 'same_session'
      : 'unknown'
  }
  async sessionCosts(req: { sinceMs: number; agentIds: string[] }) {
    return readProfileSessionCosts(req, this.options.hermesHome)
  }
  async listTasks(filter: Parameters<HermesPort['listTasks']>[0] = {}) {
    const { db } = this.requireStarted()
    const parsed = TaskFilterSchema.parse(filter)
    await this.refreshTasks()
    return db.read((sqlite) =>
      projectedTasks(sqlite)
        .filter((task) => matchesTask(task, parsed))
        .map(taskSummary),
    )
  }
  async getTask(id: string) {
    const { db } = this.requireStarted()
    z.string().min(1).max(256).parse(id)
    await this.refreshTasks()
    return db.read((sqlite) => {
      const task = readProjectedTask(sqlite, id)
      if (!task) throw new HttpError(404, 'not_found', 'Couldn’t find that task.')
      return taskWithApproval(sqlite, task)
    })
  }
  async createTask(req: Parameters<HermesPort['createTask']>[0], key: string) {
    const { db } = this.requireStarted()
    return createTask(req, key, { db, ...this.writeDeps() })
  }
  async patchTask(id: string, req: Parameters<HermesPort['patchTask']>[1]) {
    this.requireStarted()
    return patchTask(id, req, this.writeDeps())
  }
  private writeDeps() {
    return {
      getTask: (id: string) => this.getTask(id),
      ...(this.options.runner ? { runner: this.options.runner } : {}),
      ...(this.options.hermesHome ? { hermesHome: this.options.hermesHome } : {}),
    }
  }
  private async refreshTasks(): Promise<void> {
    try {
      await this.tasks!.poll()
    } catch {
      throw new HttpError(502, 'hermes_unavailable', 'Couldn’t read the tasks from Hermes.')
    }
  }
  async answerQuestion(req: Parameters<HermesPort['answerQuestion']>[0]) {
    assertThawed(this.options.frozen)
    const { db, gateway } = this.requireStarted()
    const row = readRun(db.sqlite, req.runId)
    if (row.profile !== req.agentId || row.origin !== 'score')
      throw new HttpError(409, 'conflict', 'This question isn’t on a run Score started.')
    return gateway.submitClarify(
      req.agentId,
      { runId: req.runId, promptId: req.promptId, generation: req.generation, answer: req.answer },
      row.credential_generation ?? undefined,
    )
  }
  async deliverDecision(
    req: Parameters<HermesPort['deliverDecision']>[0],
  ): Promise<'applied' | 'not_pending' | 'failed'> {
    try {
      const hold = this.options.frozen?.() ?? null
      if (hold !== null) throw new ApprovalDeliveryError('execution_frozen', false, true)
      const { db, gateway } = this.requireStarted()
      const target = DecisionDeliveryRequestSchema.extend({ runId: z.string().min(1) }).parse(req)
      const row = readRun(db.sqlite, target.runId)
      if (
        row.profile !== target.profile ||
        row.origin !== 'score' ||
        row.credential_generation === null
      )
        throw new ApprovalDeliveryError('invalid_target', false, false)
      return await gateway.submitApproval(target.profile, target, row.credential_generation)
    } catch (error) {
      if (error instanceof ApprovalDeliveryError) throw error
      if (error instanceof CredentialsUnavailable)
        throw new ApprovalDeliveryError('credentials_unavailable', false, false)
      if (error instanceof HermesHttpError) {
        const retryable =
          error.status === 0 || error.status >= 500 || [408, 429].includes(error.status)
        throw new ApprovalDeliveryError(
          error.code,
          retryable || error.status === 200 ? error.maybeApplied : false,
          retryable,
        )
      }
      throw new ApprovalDeliveryError('invalid_target', false, false)
    }
  }
}
