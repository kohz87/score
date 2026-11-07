import type { BotInputEvent } from '@score/contract'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { z } from 'zod'
import { HttpError } from '../../errors.ts'
import type { BotTakeResult, HermesPort, ObservationSink } from '../port.ts'
import { CredentialsUnavailable } from './credentials.ts'
import { computeFingerprint, evaluateCompatibility } from './fingerprint.ts'
import { GatewayClient } from './gateway.ts'
import { RunIntents } from './intents.ts'
import { StateSchema } from './live-port-types.ts'
import { resolveHermesHome } from './paths.ts'
import { LiveTasks } from './tasks.ts'
import { RunRowSchema } from './translate.ts'
import type { LivePortRuntime } from './live-port-runtime.ts'

export const lifecycleMethods = {
  async start(this: LivePortRuntime, sink: ObservationSink): Promise<void> {
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
  },
  /** Why Score holds all agent work, or null (decision 72). The chat dispatcher asks before it pumps. */
  executionHold(this: LivePortRuntime): string | null {
    return this.options.frozen?.() ?? null
  },
  botScreenStatus(this: LivePortRuntime, agentId: string, viewer?: string) {
    return this.botScreens.status(agentId, viewer)
  },
  botScreenFrame(this: LivePortRuntime, agentId: string, viewer?: string) {
    return this.botScreens.frame(agentId, viewer)
  },
  async botScreenTake(
    this: LivePortRuntime,
    agentId: string,
    owner: string,
  ): Promise<BotTakeResult> {
    const takeovers = this.botTakeovers
    if (!takeovers)
      return { ok: false, code: 'unavailable', message: 'Taking over isn’t available here.' }
    const result = await takeovers.take(agentId, owner)
    if (!result.ok) return result
    const { takeoverId, since, lastInput, expiresAt } = result.control
    return { ok: true, takeoverId, since, lastInput, expiresAt }
  },
  botScreenInput(
    this: LivePortRuntime,
    agentId: string,
    owner: string,
    takeoverId: string,
    events: readonly BotInputEvent[],
  ) {
    return this.botScreens.input(agentId, owner, takeoverId, events)
  },
  botScreenHeartbeat(this: LivePortRuntime, agentId: string, owner: string, takeoverId: string) {
    return this.botTakeovers?.heartbeat(agentId, owner, takeoverId) ?? false
  },
  async botScreenHandBack(
    this: LivePortRuntime,
    agentId: string,
    owner: string,
    takeoverId: string,
  ) {
    return (await this.botTakeovers?.handBack(agentId, owner, takeoverId)) ?? false
  },
  async stop(this: LivePortRuntime): Promise<void> {
    await this.botTakeoversValue?.close()
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
  },
  status(this: LivePortRuntime): ReturnType<HermesPort['status']> {
    return structuredClone(this.current)
  },
  refreshStatus(this: LivePortRuntime): Promise<void> {
    if (this.refresh) return this.refresh
    this.refresh = this.loadStatus().finally(() => {
      this.refresh = undefined
      // Even a status read that failed releases the agent reads waiting for the first one (they don't wait again).
      this.statusReady()
    })
    return this.refresh
  },
  async loadStatus(this: LivePortRuntime): Promise<void> {
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
  },
  requireStarted(this: LivePortRuntime) {
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
  },
}

export type LifecycleMethods = typeof lifecycleMethods
