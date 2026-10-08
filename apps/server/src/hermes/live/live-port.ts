import { type AgentSummary } from '@score/contract'
import { ProfilesReader, agentSummary } from './profiles.ts'
import { ProfileFiles } from './profile-files.ts'
import type { AgentFile, AgentFileName } from '../agent-files.ts'
import type { AgentDetail } from '@score/contract'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { ScoreDb } from '../../db/index.ts'
import { HttpError } from '../../errors.ts'
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
} from '../port.ts'
import { CredentialsUnavailable } from './credentials.ts'
import {
  assertFeature,
  computeFingerprint,
  evaluateCompatibility,
  testedFingerprints,
  type Fingerprint,
  type FingerprintInputs,
  type TestedFingerprint,
} from './fingerprint.ts'
import { GatewayClient, HermesHttpError } from './gateway.ts'
import { RunIntents } from './intents.ts'
import { ProfileNameSchema, resolveHermesHome } from './paths.ts'
import { followRun, waitForRun, type FollowOptions } from './runs.ts'
import { taskAction, taskReader } from './task-actions.ts'
import { LiveTasks } from './tasks.ts'
import { createTask, patchTask } from './task-writes.ts'
import { LiveRoutines } from './routines.ts'
import { LiveAgentTabs } from './agent-tabs.ts'
import { MemoryIdSchema } from '../agent-tabs.ts'
import { createLiveConfigService } from './config.ts'
import { LiveSettings } from './settings.ts'
import type { HermesRunner } from './cli.ts'
import { readRun, RunRowSchema, runLifecycle, type RunMetrics } from './translate.ts'

const StateSchema = z.object({ served_profiles: z.array(ProfileNameSchema) })
export interface LivePortOptions extends HermesPortDeps {
  scoreHome: string
  hermesHome?: string
  baseUrl?: string
  db?: ScoreDb
  runner?: HermesRunner
  fetch?: typeof globalThis.fetch
  readCliVersion?: FingerprintInputs['readCliVersion']
  testedFingerprints?: readonly TestedFingerprint[]
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
  private readonly config: ReturnType<typeof createLiveConfigService>
  private readonly profileFiles = new ProfileFiles()
  constructor(private readonly options: LivePortOptions) {
    this.profiles = new ProfilesReader(resolveHermesHome(options.hermesHome), options.runner)
    this.routines = new LiveRoutines(options.hermesHome, options.runner)
    this.tabs = new LiveAgentTabs(
      resolveHermesHome(options.hermesHome),
      (profile) => this.profiles.profileHome(profile),
      (profile) => this.profiles.invalidate(profile),
      options.runner,
    )
    this.settings = new LiveSettings(options.hermesHome, options.runner)
    this.config = createLiveConfigService(options.hermesHome, options.runner)
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
      this.intents = new RunIntents({ db: this.db, gateway: this.gateway, sink })
      await this.refreshStatus()
      await this.intents.recoverIntents()
      const rows = z
        .array(RunRowSchema)
        .parse(
          this.db.sqlite
            .prepare(
              `SELECT * FROM runs WHERE origin = 'score' AND status IN ('queued','running','waiting_for_approval')`,
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
  async stop(): Promise<void> {
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
    const compatibility = evaluateCompatibility(
      this.fingerprint,
      this.options.testedFingerprints ?? testedFingerprints,
    )
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
  async listAgentDetails(): Promise<AgentDetail[]> {
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
    this.requireStarted()
    await this.routines.run(id)
  }
  async setAgentModel(agentId: string, req: Parameters<HermesPort['setAgentModel']>[1]) {
    this.requireStarted()
    await this.tabs.setModel(agentId, req)
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
  async setToolEnabled(agentId: string, toolId: string, enabled: boolean) {
    this.requireStarted()
    return this.tabs.setToolEnabled(agentId, toolId, enabled)
  }
  async listProviders() {
    return this.settings.listProviders()
  }
  async connectProvider(id: string) {
    return this.settings.connectProvider(id)
  }
  async addLocalProvider(req: Parameters<HermesPort['addLocalProvider']>[0]) {
    return this.settings.addLocalProvider(req)
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
    if (!home) throw new HttpError(404, 'not_found', 'Agent not found')
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
      throw new HttpError(503, 'hermes_unavailable', 'Live adapter is not started')
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
  }): Promise<{ runId: string }> {
    const { intents } = this.requireStarted()
    assertFeature(this.current, 'score-runs')
    if (!this.current.hermes.servedProfiles.includes(req.agentId))
      throw new HttpError(503, 'hermes_unavailable', 'Profile is not served')
    const result = await intents.startRunIntent(
      {
        profile: req.agentId,
        input: req.input,
        ...(req.model ? { model: req.model } : {}),
        ...(req.sessionId ? { sessionId: req.sessionId } : {}),
      },
      req.turnId,
    )
    this.follow(result.runId)
    return result
  }
  async stopRun(req: { agentId: string; runId: string }): Promise<void> {
    const { db, gateway } = this.requireStarted()
    const row = readRun(db.sqlite, req.runId)
    if (row.profile !== req.agentId) throw new HttpError(404, 'not_found', 'Unknown run')
    await gateway.stopRun(req.agentId, req.runId, row.credential_generation ?? undefined)
  }
  async taskAction(
    req: Parameters<HermesPort['taskAction']>[0],
  ): Promise<{ hermesStatus: string }> {
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
      if (!task) throw new HttpError(404, 'not_found', 'Unknown task')
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
      throw new HttpError(502, 'hermes_unavailable', 'Task data unavailable')
    }
  }
  async deliverDecision(
    req: Parameters<HermesPort['deliverDecision']>[0],
  ): Promise<'applied' | 'not_pending' | 'failed'> {
    try {
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
