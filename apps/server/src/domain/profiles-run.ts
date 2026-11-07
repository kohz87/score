import { randomUUID } from 'node:crypto'
import { AgentSummarySchema, type AgentOperation } from '@score/contract'
import { HttpError } from '../errors.ts'
import { ProfileInventorySchema } from '../hermes/index.ts'
import { readAgent, reconcileAgents, storeAgent } from './agents.ts'
import { applyLifecycle } from './agent-lifecycle.ts'
import type { ProfileOperationsRuntime } from './profiles-runtime.ts'
import {
  AbandonedOperation,
  OperationRow,
  RETRYABLE_STEPS,
  StoredRequest,
  type StoredRequestValue,
} from './profiles-support.ts'
import { retireAgentFromRooms } from './rooms.ts'
import { readBaseline } from './team-rules.ts'
import { syncTeamRoomMembers } from './team-room.ts'

export const runMethods = {
  async save(this: ProfileOperationsRuntime, operation: AgentOperation, identity?: string | null) {
    await this.ingest.submit({
      source: 'profile-operations',
      identity: randomUUID(),
      apply: ({ sqlite, now }) => {
        // A completed operation is final: a Retry, Confirm or run step still in flight when a removal abandoned the
        // setup must not bring it back to life.
        const saved = sqlite
          .prepare(
            "UPDATE profile_operations SET operation = ?, state = ?, target_identity = COALESCE(?, target_identity) WHERE id = ? AND state != 'completed'",
          )
          .run(JSON.stringify(operation), operation.state, identity ?? null, operation.id)
        if (saved.changes === 0) throw new AbandonedOperation()
        if (operation.state !== 'running') {
          sqlite
            .prepare('UPDATE agent_lifecycle SET state = ?, operation_id = ? WHERE agent_id = ?')
            .run(
              operation.state === 'needs_attention'
                ? 'needs_attention'
                : operation.kind === 'delete'
                  ? 'removed'
                  : 'ready',
              operation.id,
              operation.targetName,
            )
          const previous = readAgent(sqlite, operation.targetName)
          if (previous) {
            const agent = applyLifecycle(sqlite, previous)
            storeAgent(sqlite, agent)
            // An agent joins the team room once it is ready (and leaves when removed).
            return [
              { type: 'agent.updated', data: AgentSummarySchema.parse(agent) },
              ...syncTeamRoomMembers(sqlite, now),
            ]
          }
          return syncTeamRoomMembers(sqlite, now)
        }
        return []
      },
    })
  },
  async run(this: ProfileOperationsRuntime, id: string) {
    const operation = this.get(id)
    if (operation.state === 'needs_attention' && operation.nextStep === 'verify_ready') {
      // Readiness is read-only: recheck a delayed handshake without repeating provisioning writes.
      operation.state = 'running'
      operation.error = null
      const verification = operation.steps.find((step) => step.name === 'verify_ready')
      if (verification) verification.state = 'pending'
    }
    if (operation.state !== 'running') return
    const row = OperationRow.parse(
      this.db.sqlite.prepare('SELECT * FROM profile_operations WHERE id = ?').get(id),
    )
    const stored = StoredRequest.parse(JSON.parse(row.request))
    let identity = row.target_identity
    const importArchive = stored.importUpload ? this.imports?.pathFor(stored.importUpload) : null
    try {
      for (const step of operation.steps) {
        if (step.state === 'completed') continue
        // Abandoned while this run was between steps: stop before touching Hermes again.
        const current = this.db.sqlite
          .prepare('SELECT state FROM profile_operations WHERE id = ?')
          .get(id) as { state: string } | undefined
        if (current?.state === 'completed') return
        operation.nextStep = step.name
        if (step.state === 'running' && step.name !== 'verify_ready')
          throw new Error(
            'An external step was interrupted. Verify its postcondition manually before continuing; Score will not repeat or adopt it.',
          )
        if (this.closed) return
        if (operation.kind === 'delete' && ['export', 'delete_profile'].includes(step.name)) {
          const busy = this.pending(operation.targetName)
          if (busy.activeRuns || busy.queuedTurns || busy.pendingApprovals || busy.assignments)
            throw new HttpError(
              409,
              'conflict',
              'New work arrived while Score was preparing. Finish it before the next step.',
            )
        }
        if (operation.kind !== 'delete' && step.name === 'verify_ready')
          await this.rebaseline(operation, stored, identity)
        step.state = 'running'
        operation.updatedAt = new Date(this.clock()).toISOString()
        await this.save(operation)
        if (step.name === 'retire') {
          await this.retire(operation)
        } else {
          const result = await this.port.profileStep(step.name, {
            operationId: id,
            targetName: operation.targetName,
            targetIdentity: identity,
            createdAt: operation.createdAt,
            input: stored.input,
            baseline: stored.baseline,
            exportPath: operation.exportPath,
            importArchive,
          })
          identity = result.identity
        }
        step.state = 'completed'
        // Hermes has copied what it needs; the upload is not needed by any later step.
        if (step.name === 'import_profile' && stored.importUpload)
          this.imports?.remove(stored.importUpload)
        await this.save(operation, identity)
      }
      if (this.closed) return
      if (operation.kind !== 'delete') {
        const inventory = ProfileInventorySchema.parse(
          await this.port.profileInventory(operation.targetName),
        )
        if (inventory.identity !== identity)
          throw new HttpError(
            409,
            'conflict',
            'The profile changed before Score finished setting it up.',
          )
        await this.rebaseline(operation, stored, identity)
        if (JSON.stringify(readBaseline(this.db.sqlite)) !== JSON.stringify(stored.baseline))
          throw new HttpError(
            409,
            'conflict',
            'The team rules changed while the agent was being set up. Apply the current team rules again.',
          )
        await this.port.profileStep('verify_ready', {
          operationId: id,
          targetName: operation.targetName,
          targetIdentity: identity,
          createdAt: operation.createdAt,
          input: stored.input,
          baseline: stored.baseline,
          exportPath: operation.exportPath,
          importArchive,
        })
        await reconcileAgents(this.ingest, await this.port.listAgentDetails())
      } else if ((await this.port.profileInventory(operation.targetName)).exists) {
        throw new HttpError(
          409,
          'conflict',
          'Another profile appeared with this name before the agent was removed. Check it on the Hermes machine.',
        )
      }
      operation.state = 'completed'
      operation.nextStep = null
      operation.updatedAt = new Date(this.clock()).toISOString()
      await this.save(operation)
      if (operation.kind !== 'delete')
        await reconcileAgents(this.ingest, await this.port.listAgentDetails())
      // The uploaded archive has served its purpose; nothing keeps it after a finished import.
      if (stored.importUpload) this.imports?.remove(stored.importUpload)
    } catch (error) {
      if (error instanceof AbandonedOperation) return
      // A refused or interrupted import step never reuses the archive (it is not retryable), so don't keep 200 MiB.
      if (operation.nextStep === 'import_profile' && stored.importUpload)
        this.imports?.remove(stored.importUpload)
      operation.state = 'needs_attention'
      // Not an HttpError: Score could not verify the step (it was interrupted). Recorded failures are never confirmable.
      operation.confirmable = !(error instanceof HttpError) && operation.nextStep !== 'verify_ready'
      operation.retryable =
        error instanceof HttpError &&
        operation.nextStep !== null &&
        RETRYABLE_STEPS.has(operation.nextStep)
      operation.error = `Next step: ${operation.nextStep}. ${error instanceof HttpError ? error.message : 'The step could not be verified. Inspect the profile locally; no automatic retry or rollback was attempted.'}`
      operation.updatedAt = new Date(this.clock()).toISOString()
      try {
        await this.save(operation, identity)
      } catch (saveError) {
        // Completed meanwhile (finished before a late failure, or abandoned by a removal): nothing to record.
        if (!(saveError instanceof AbandonedOperation)) throw saveError
      }
    }
  },
  /**
   * Team rules changed while the agent was being set up: apply the current rules to it and remember them as the
   * operation's baseline, so readiness is judged against the rules the agent actually has.
   */
  async rebaseline(
    this: ProfileOperationsRuntime,
    operation: AgentOperation,
    stored: StoredRequestValue,
    identity: string | null,
  ) {
    const current = readBaseline(this.db.sqlite)
    if (JSON.stringify(current) === JSON.stringify(stored.baseline)) return
    await this.port.profileStep('permissions', {
      operationId: operation.id,
      targetName: operation.targetName,
      targetIdentity: identity,
      createdAt: operation.createdAt,
      input: stored.input,
      baseline: current,
      previousNever: stored.baseline.never,
      exportPath: operation.exportPath,
    })
    stored.baseline = current
    await this.ingest.submit({
      source: 'profile-operations',
      identity: randomUUID(),
      apply: ({ sqlite }) => {
        sqlite
          .prepare('UPDATE profile_operations SET request = ? WHERE id = ?')
          .run(JSON.stringify(stored), operation.id)
        return []
      },
    })
  },
  async retire(this: ProfileOperationsRuntime, operation: AgentOperation) {
    await this.ingest.submit({
      source: 'profile-operations',
      identity: `retire:${operation.id}`,
      apply: ({ sqlite, now }) => {
        const events = retireAgentFromRooms(sqlite, operation.targetName, now)
        sqlite
          .prepare('DELETE FROM agent_rule_overrides WHERE agent_id = ?')
          .run(operation.targetName)
        // Credential files and backups are retained privately; invalidate generations and bridge tokens in Score.
        sqlite.prepare('DELETE FROM credentials WHERE profile = ?').run(operation.targetName)
        // MCP access (7.4d): token and both switches go with the agent, so a profile of the same name starts from off.
        sqlite.prepare('DELETE FROM mcp_access WHERE agent_id = ?').run(operation.targetName)
        // A pause goes with the agent too, so a later agent of the same name doesn't start held (2.0.8).
        sqlite.prepare('DELETE FROM agent_pauses WHERE agent_id = ?').run(operation.targetName)
        sqlite
          .prepare('UPDATE producers SET token_expires_at = 0 WHERE profile = ?')
          .run(operation.targetName)
        return events
      },
    })
  },
}

export type RunMethods = typeof runMethods
