import { AgentSummarySchema, type AgentSummary } from '@score/contract'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import type { ScoreDb } from '../../db/index.ts'
import { HttpError } from '../../errors.ts'
import type { HermesPort, HermesPortDeps, ObservationSink } from '../port.ts'
import { CredentialsUnavailable, readKey } from './credentials.ts'
import { GatewayClient } from './gateway.ts'
import { RunIntents } from './intents.ts'
import { ProfileNameSchema, resolveHermesHome } from './paths.ts'
import { followRun, type FollowOptions } from './runs.ts'
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
  fetch?: typeof globalThis.fetch
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
  private refresh: Promise<void> | undefined
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
      disabled: ['gateway-approvals', 'kanban-grants'],
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
    this.controller?.abort()
    await this.intents?.drain()
    await Promise.allSettled([...this.followers.values()])
    await this.refresh
    this.followers.clear()
    this.sink = undefined
    this.intents = undefined
    this.gateway = undefined
    this.db = undefined
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
    for (const profile of served) {
      try {
        const features = await this.gateway!.capabilities(profile)
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
    this.current = {
      ...this.current,
      hermes: {
        version,
        reachable,
        apiServer: reachable,
        capabilities: [...capabilities].sort(),
        servedProfiles: served,
      },
      compatibility: { ...this.current.compatibility, fingerprint: version ?? 'unavailable' },
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
    const pending = followRun({
      db,
      gateway,
      sink,
      signal,
      context: { profile: row.profile, runId, credentialGeneration: row.credential_generation },
      metrics: this.metrics,
      ...this.options.following,
    })
      .catch((error: unknown) => {
        if (error instanceof CredentialsUnavailable)
          this.current.degraded.push(`${row.profile}: credentials unavailable`)
        this.options.onError?.(error)
      })
      .finally(() => this.followers.delete(runId))
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
  async deliverDecision(): Promise<never> {
    throw new HttpError(503, 'hermes_unavailable', 'Approval delivery is not implemented yet')
  }
}
