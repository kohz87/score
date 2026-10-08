import { AgentSummarySchema, type AgentSummary } from '@score/contract'
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
import { CredentialsUnavailable, readKey } from './credentials.ts'
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
import type { HermesRunner } from './cli.ts'
import { readRun, RunRowSchema, runLifecycle, type RunMetrics } from './translate.ts'

const palette = [
  { color: '#6B4EFF', shape: 'circle-dot' },
  { color: '#19C39A', shape: 'triangle' },
  { color: '#FFB61E', shape: 'diamond' },
  { color: '#FF6B8A', shape: 'square' },
] as const
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
  constructor(private readonly options: LivePortOptions) {}

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
    const agents: AgentSummary[] = []
    for (const [index, profile] of this.current.hermes.servedProfiles.entries()) {
      try {
        readKey(this.options.scoreHome, profile)
      } catch {
        continue
      }
      const active = this.db?.sqlite
        .prepare(
          `SELECT * FROM runs WHERE profile = ? AND status IN ('queued','running','waiting_for_approval') ORDER BY started_at DESC LIMIT 1`,
        )
        .get(profile)
      const row = active === undefined ? undefined : RunRowSchema.parse(active)
      agents.push(
        AgentSummarySchema.parse({
          id: profile,
          name: profile,
          role: 'Agent',
          style: palette[index % palette.length],
          status: row?.status === 'waiting_for_approval' ? 'waiting' : row ? 'working' : 'idle',
          activity: row ? 'Running a turn' : null,
          model: row?.model ? { id: row.model, label: row.model } : null,
          served: true,
        }),
      )
    }
    return agents
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
