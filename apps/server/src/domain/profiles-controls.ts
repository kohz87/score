import type { AgentOperation } from '@score/contract'
import { z } from 'zod'
import { HttpError } from '../errors.ts'
import { ProfileInventorySchema } from '../hermes/index.ts'
import type { ProfileOperationsRuntime } from './profiles-runtime.ts'
import { RETRYABLE_STEPS } from './profiles-support.ts'

export const controlMethods = {
  launch(this: ProfileOperationsRuntime, id: string) {
    if (this.closed || this.flights.has(id)) return
    // Let the accepted response and the Setting up event reach the browser before provisioning.
    const flight = new Promise<void>((resolve) => setImmediate(resolve))
      .then(() => this.run(id))
      .finally(() => this.flights.delete(id))
    this.flights.set(id, flight)
  },
  async recover(this: ProfileOperationsRuntime) {
    const ids = z
      .array(z.object({ id: z.uuid() }))
      .parse(
        this.db.sqlite
          .prepare(
            `SELECT id FROM profile_operations WHERE state = 'running' OR (state = 'needs_attention' AND json_extract(operation, '$.nextStep') = 'verify_ready')`,
          )
          .all(),
      )
    for (const { id } of ids) this.launch(id)
  },
  /**
   * A person retries a step that failed with a recorded error after fixing its cause. Only steps whose repeat is
   * harmless qualify; creating the profile and installing the plugin never run twice, and the delete only on the same
   * folder it began on (see `refresh`).
   */
  retry(this: ProfileOperationsRuntime, id: string) {
    const operation = this.get(id)
    const step = operation.steps.find((item) => item.name === operation.nextStep)
    // Operations saved before `retryable` existed: a recorded (not generic) error on a harmless step qualifies.
    const retryable =
      operation.retryable ??
      (step !== undefined &&
        RETRYABLE_STEPS.has(step.name) &&
        !operation.error?.includes('could not be verified'))
    if (operation.state !== 'needs_attention' || !retryable || !step)
      throw new HttpError(
        409,
        'conflict',
        'This step can’t be retried from Score. Check the profile on the Hermes machine first.',
      )
    step.state = 'pending'
    operation.state = 'running'
    operation.error = null
    operation.retryable = false
    operation.updatedAt = new Date(this.clock()).toISOString()
    return this.save(operation).then(() => {
      this.launch(id)
      return operation
    })
  },
  /**
   * The person checked an interrupted step on the Hermes machine and says it finished. Only for steps Score lost track
   * of (never a recorded failure: "continue" after "profile already exists" would adopt someone else's profile), and
   * Score still checks what it can see: a created profile must exist, a deleted one must be gone.
   */
  async confirm(this: ProfileOperationsRuntime, id: string, stepName: string) {
    const operation = this.get(id)
    const step = operation.steps.find((item) => item.name === operation.nextStep)
    if (
      operation.state !== 'needs_attention' ||
      !operation.confirmable ||
      !step ||
      step.name !== stepName ||
      step.state !== 'running'
    )
      throw new HttpError(409, 'conflict', 'This step can’t be confirmed from Score.')
    let identity: string | null | undefined
    if (
      step.name === 'create_profile' ||
      step.name === 'import_profile' ||
      step.name === 'delete_profile'
    ) {
      const inventory = ProfileInventorySchema.parse(
        await this.port.profileInventory(operation.targetName),
      )
      if (step.name !== 'delete_profile' && !inventory.exists)
        throw new HttpError(409, 'conflict', 'The profile doesn’t exist, so it was not created.')
      if (step.name === 'delete_profile' && inventory.exists)
        throw new HttpError(409, 'conflict', 'The profile still exists, so it was not deleted.')
      if (step.name !== 'delete_profile') identity = inventory.identity
    }
    step.state = 'completed'
    operation.state = 'running'
    operation.error = null
    operation.retryable = false
    operation.confirmable = false
    operation.updatedAt = new Date(this.clock()).toISOString()
    await this.save(operation, identity)
    this.launch(id)
    return operation
  },
  async refresh(this: ProfileOperationsRuntime, id: string) {
    const operation = this.get(id)
    if (operation.state === 'needs_attention' && operation.nextStep === 'verify_ready')
      this.launch(id)
    // 3.7.3: a delete Hermes didn't finish (its gateway still owned the profile and recreated folders while it was being
    // removed; Hermes says "retry the delete once it settles") may be retried — but only on the very folder Score
    // recorded when the removal began, or once it is gone: a new profile with the same name is never deleted.
    if (
      operation.state === 'needs_attention' &&
      operation.kind === 'delete' &&
      operation.nextStep === 'delete_profile' &&
      !operation.retryable &&
      (await this.deleteRetrySafe(operation))
    ) {
      operation.retryable = true
      await this.save(operation)
    }
    return operation
  },
  async deleteRetrySafe(
    this: ProfileOperationsRuntime,
    operation: AgentOperation,
  ): Promise<boolean> {
    const recorded = this.db.sqlite
      .prepare('SELECT target_identity FROM profile_operations WHERE id = ?')
      .get(operation.id) as { target_identity: string | null } | undefined
    const inventory = ProfileInventorySchema.parse(
      await this.port.profileInventory(operation.targetName),
    )
    return (
      !inventory.exists ||
      (recorded?.target_identity != null && inventory.identity === recorded.target_identity)
    )
  },

  async close(this: ProfileOperationsRuntime) {
    this.closed = true
    await Promise.allSettled([...this.flights.values()])
  },
}

export type ControlMethods = typeof controlMethods
