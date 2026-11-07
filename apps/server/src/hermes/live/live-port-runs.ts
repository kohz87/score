import { assertAgentAdmits } from '../../domain/agent-lifecycle.ts'
import { assertNotKanbanAttempt } from '../../domain/kanban-attempts.ts'
import { HttpError } from '../../errors.ts'
import type { HermesPort } from '../port.ts'
import { notDispatched } from '../port.ts'
import { compactSession, sessionContext } from './compact.ts'
import { CredentialsUnavailable } from './credentials.ts'
import { assertFeature } from './fingerprint.ts'
import { assertThawed } from './freeze.ts'
import { HermesHttpError } from './gateway.ts'
import type { RunIntents } from './intents.ts'
import { STOP_GRACE_MS } from './live-port-types.ts'
import { sessionRetired } from './outside-sessions.ts'
import { recoverRunOutput } from './recover.ts'
import { rewindSession } from './rewind.ts'
import { followRun, waitForRun } from './runs.ts'
import { readRun, runLifecycle, runLostObservation } from './translate.ts'
import type { LivePortRuntime } from './live-port-runtime.ts'

export const runMethods = {
  follow(this: LivePortRuntime, runId: string): void {
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
  },
  async startRun(
    this: LivePortRuntime,
    req: {
      agentId: string
      input: string
      turnId: string
      sessionId?: string
      model?: string
      provider?: string
      images?: string[]
      owner?: 'orchestration'
      render?: (stored: string) => string
    },
  ): Promise<{ runId: string }> {
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
  },
  async stopRun(this: LivePortRuntime, req: { agentId: string; runId: string }): Promise<void> {
    // Kanban attempts are not runs and cannot be stopped from Score: refused before any profile or run lookup.
    assertNotKanbanAttempt(req.runId)
    // Any Stop (a message's, a Flow's, a person's) can name a run that belongs to another installation (decision 72).
    assertThawed(this.options.frozen)
    const { db, gateway } = this.requireStarted()
    const row = readRun(db.sqlite, req.runId)
    if (row.profile !== req.agentId)
      throw new HttpError(404, 'not_found', 'Couldn’t find that run.')
    const context = {
      profile: req.agentId,
      runId: req.runId,
      credentialGeneration: row.credential_generation ?? 0,
    }
    // Old entries go (a run that ended normally keeps none past the hour).
    for (const [runId, at] of this.stopAsked)
      if (Date.now() - at > 3_600_000) this.stopAsked.delete(runId)
    const asked = this.stopAsked.get(req.runId)
    try {
      await gateway.stopRun(req.agentId, req.runId, row.credential_generation ?? undefined)
      // 3.7.2: Hermes can accept a stop and never end the run (one blocked on an approval it forgot). Asked again after
      // the grace, Score ends its own record as stopped, so the job and the agent are free; Hermes may keep its copy.
      if (
        asked !== undefined &&
        Date.now() - asked >= STOP_GRACE_MS &&
        !runLifecycle.isTerminal(readRun(db.sqlite, req.runId).status) &&
        this.sink
      ) {
        this.stopAsked.delete(req.runId)
        await this.sink.submit(
          runLostObservation(context, true, 'Hermes accepted the stop but the run never ended'),
        )
        return
      }
      if (asked === undefined) this.stopAsked.set(req.runId, Date.now())
    } catch (error) {
      // 3.7.1: Hermes no longer has the run (it was lost, or ended while nobody followed it). Stopping it means ending
      // Score's record the way a lost run ends, so its turn and the agent are free again.
      if (
        error instanceof HermesHttpError &&
        error.status === 404 &&
        error.code === 'run_not_found' &&
        this.sink
      ) {
        await this.sink.submit(runLostObservation(context, true))
        return
      }
      throw error
    }
  },
  rewindSession(this: LivePortRuntime, req: Parameters<HermesPort['rewindSession']>[0]) {
    return rewindSession(req, {
      broker: this.options.rewindBroker,
      ...(this.options.hermesHome ? { hermesHome: this.options.hermesHome } : {}),
    })
  },
  compactSession(
    this: LivePortRuntime,
    req: { agentId: string; sessionId: string; keepRecent?: number },
  ) {
    return compactSession(req, {
      broker: this.options.rewindBroker,
      ...(this.options.hermesHome ? { hermesHome: this.options.hermesHome } : {}),
    })
  },
  sessionContext(this: LivePortRuntime, req: { agentId: string; sessionId: string }) {
    return sessionContext(req, {
      broker: this.options.rewindBroker,
      ...(this.options.hermesHome ? { hermesHome: this.options.hermesHome } : {}),
    })
  },
}

export type RunMethods = typeof runMethods
