import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
import type { DatabaseSync } from 'node:sqlite'
import {
  AgentCreateInputSchema,
  AgentDetailSchema,
  AgentOperationSchema,
  AgentPreviewSchema,
  AgentPreviewRequestSchema,
  AgentSummarySchema,
  type AgentImportRequest,
  type AgentOperation,
  type AgentPreviewRequest,
  type ProfileStepName,
} from '@score/contract'
import type { ScoreDb } from '../db/index.ts'
import type { HermesPort } from '../hermes/index.ts'
import { ProfileInventorySchema } from '../hermes/index.ts'
import type { Ingest } from '../hub/ingest.ts'
import { HttpError } from '../errors.ts'
import { redact } from '../redact.ts'
import { readAgent, reconcileAgents, storeAgent, writeAgentStyle } from './agents.ts'
import { applyLifecycle, lifecycleOf } from './agent-lifecycle.ts'
import type { ProfileImportStore } from './profile-imports.ts'
import { readBaseline } from './team-rules.ts'
import { syncTeamRoomMembers } from './team-room.ts'
import { retireAgentFromRooms } from './rooms.ts'

const OperationRow = z.object({
  operation: z.string(),
  request: z.string(),
  target_identity: z.string().nullable(),
})
const StoredRequest = z.object({
  input: AgentCreateInputSchema.nullable(),
  /** Import only: the uploaded archive this operation installs from. */
  importUpload: z.uuid().nullable().optional(),
  baseline: z.object({
    mode: z.enum(['manual', 'smart', 'off']),
    goAhead: z.array(z.string()),
    never: z.array(z.string()),
  }),
})
const emptyInherited = {
  memories: [],
  skills: [],
  plugins: [],
  approvalSettings: [],
  credentialsPresent: [],
}
const createSteps: ProfileStepName[] = [
  'create_profile',
  'preserve_key',
  'configure_key',
  'model',
  'permissions',
  'install_bridge',
  'enable_bridge',
  'verify_ready',
]
const importSteps: ProfileStepName[] = [
  'import_profile',
  'describe_profile',
  'preserve_key',
  'configure_key',
  'permissions',
  'install_bridge',
  'enable_bridge',
  'verify_ready',
]
const deleteSteps: ProfileStepName[] = ['export', 'delete_profile', 'purge_identity', 'retire']

/**
 * 3.2.2: the create (or import) that stopped and holds an agent in needs_attention, when removing the agent should
 * abandon it. Null while the operation still runs or when something else holds the agent.
 */
function stoppedSetup(sqlite: DatabaseSync, name: string): { id: string } | null {
  const lifecycle = lifecycleOf(sqlite, name)
  if (lifecycle?.state !== 'needs_attention' || !lifecycle.operation_id) return null
  const row = sqlite
    .prepare(
      "SELECT id, operation FROM profile_operations WHERE id = ? AND state = 'needs_attention'",
    )
    .get(lifecycle.operation_id) as { id: string; operation: string } | undefined
  if (!row) return null
  const stored = z
    .object({ kind: z.string(), confirmable: z.boolean().optional() })
    .safeParse(JSON.parse(row.operation)).data
  // A step Score lost track of (interrupted, outcome unknown: `confirmable`) is never abandoned — Hermes may still
  // finish it, so the person confirms what happened first; only a recorded failure is abandoned.
  if (!stored || stored.confirmable === true) return null
  return stored.kind === 'create' || stored.kind === 'import' ? { id: row.id } : null
}

/** A save refused because the operation was abandoned meanwhile (a removal closed it): its run stops quietly. */
class AbandonedOperation extends HttpError {
  constructor() {
    super(409, 'conflict', 'This setup was abandoned when the agent was removed.')
  }
}
function hash(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

// Steps whose repeat is harmless: reads, idempotent config writes, the export (a retry reuses its own file) and
// Score-side retirement.
const RETRYABLE_STEPS: ReadonlySet<string> = new Set([
  'model',
  'describe_profile',
  'permissions',
  'enable_bridge',
  'verify_ready',
  'export',
  'purge_identity',
  'retire',
])

export class ProfileOperations {
  private readonly flights = new Map<string, Promise<void>>()
  private closed = false
  constructor(
    private readonly db: ScoreDb,
    private readonly ingest: Ingest,
    private readonly port: HermesPort,
    private readonly clock = Date.now,
    private readonly imports?: ProfileImportStore,
  ) {}

  get(id: string): AgentOperation {
    const row = this.db.sqlite.prepare('SELECT * FROM profile_operations WHERE id = ?').get(id)
    if (!row) throw new HttpError(404, 'not_found', 'Couldn’t find that operation.')
    return AgentOperationSchema.parse(JSON.parse(OperationRow.parse(row).operation))
  }
  private pending(name: string) {
    const count = (sql: string) =>
      z.object({ count: z.int().nonnegative() }).parse(this.db.sqlite.prepare(sql).get(name)).count
    return {
      activeRuns: count(
        `SELECT (SELECT count(*) FROM runs WHERE profile = ? AND status IN ('queued','running','waiting_for_approval')) + (SELECT count(*) FROM command_intents WHERE kind = 'start_run' AND json_extract(payload, '$.profile') = ?1 AND state IN ('pending','sent','unknown')) AS count`,
      ),
      queuedTurns: count(
        "SELECT count(*) AS count FROM message_runs WHERE agent_id = ? AND state IN ('pending','active')",
      ),
      pendingApprovals: count(
        "SELECT count(*) AS count FROM approvals WHERE profile = ? AND status = 'pending'",
      ),
      assignments: count(
        `SELECT count(*) AS count FROM task_projections WHERE (json_extract(detail, '$.assignee') = ? OR json_extract(detail, '$.reviewer') = ?1) AND json_extract(detail, '$."hermesStatus"') NOT IN ('done', 'archived')`,
      ),
      disposition:
        'Active work must finish first. Remove room membership and lead selection; keep history with removed attribution.',
    }
  }
  async preview(raw: AgentPreviewRequest) {
    const request = AgentPreviewRequestSchema.parse(raw)
    const name = request.kind === 'create' ? request.id : request.agentId
    const inventory = ProfileInventorySchema.parse(
      await this.port.profileInventory(
        name,
        request.kind === 'create' ? request.cloneFrom : undefined,
      ),
    )
    const lifecycle = lifecycleOf(this.db.sqlite, name)
    const pendingWork = this.pending(name)
    const blockers = [...inventory.blockers]
    // Removing an agent whose setup stopped abandons that setup first (3.2.2).
    const abandon = request.kind === 'delete' ? stoppedSetup(this.db.sqlite, name) : null
    if (name === 'default') blockers.push('The default profile is reserved.')
    if (request.kind === 'create') {
      if (inventory.exists)
        blockers.push(
          'A profile with this name already exists; Score never adopts it automatically.',
        )
    } else {
      if ((!inventory.exists && !abandon) || lifecycle?.state === 'removed')
        blockers.push('Agent not found.')
      if (
        pendingWork.activeRuns ||
        pendingWork.queuedTurns ||
        pendingWork.pendingApprovals ||
        pendingWork.assignments
      )
        blockers.push(
          'Finish active runs, queued turns, pending approvals and unfinished assignments before deleting.',
        )
    }
    if (lifecycle && !['ready', 'removed'].includes(lifecycle.state) && !abandon)
      blockers.push('An operation already holds this agent.')
    // A removed agent's name may be used again on purpose (2.0.8): its history keeps the name, so the person confirms.
    const reusesName = request.kind === 'create' && lifecycle?.state === 'removed'
    let providerLabel = request.kind === 'create' ? (request.provider ?? '') : ''
    if (request.kind === 'create' && request.provider) {
      const match = (await this.port.listModels(request.model).catch(() => [])).find(
        (item) => item.provider === request.provider && item.model === request.model,
      )
      if (match) providerLabel = match.providerLabel
    }
    const exportPath =
      request.kind === 'delete' && inventory.exists
        ? this.port.profileExportPath(name, inventory.revision)
        : null
    const data = {
      kind: request.kind,
      targetName: name,
      inherited: request.kind === 'create' ? inventory.inherited : emptyInherited,
      effects:
        request.kind === 'create'
          ? [
              request.cloneFrom
                ? `Copy ${request.cloneFrom}: configuration, personality, skills, memories, installed plugins and non-channel credentials.`
                : 'Seed the default model configuration and bundled skills; no existing conversations or jobs.',
              'No channel credentials, session history, jobs or AGENTS.md are cloned.',
              'The host gateway may discover the profile during setup. Score routes no work until all checks pass.',
              request.provider
                ? `Set the model to ${request.model} via ${providerLabel}.`
                : `Set the model to ${request.model}.`,
              'Preserve a fresh private Score key; set the chosen model and team rules; install and enable the bridge; verify authenticated gateway access and a new bridge handshake.',
              ...(reusesName
                ? [
                    `${name} was used by an agent that was removed. Its messages, runs and reports keep the name ${name} and will show next to the new agent; nothing else carries over.`,
                  ]
                : []),
            ]
          : [
              ...(abandon
                ? [
                    inventory.exists
                      ? 'The setup that stopped is abandoned first; what it made is exported and deleted like any agent.'
                      : 'The setup that stopped is abandoned first. Hermes never made the profile, so there is nothing to export or delete: Score only retires the name.',
                  ]
                : []),
              'Freeze new admissions, export privately, delete and purge profile identity, then retire routing references.',
              'The export omits credentials and is not a full undo. It may contain sensitive conversations and is kept privately until you remove it locally.',
            ],
      blockers,
      pendingWork,
      exportPath,
      ...(reusesName ? { reusesName: true } : {}),
    }
    return AgentPreviewSchema.parse({
      ...data,
      hash: hash({
        request,
        data,
        revision: inventory.revision,
        lifecycle: lifecycle?.incarnation_id ?? null,
        baseline: readBaseline(this.db.sqlite),
      }),
    })
  }
  async begin(
    request: AgentPreviewRequest,
    expectedHash: string,
    confirm = false,
    imported?: { uploadId: string },
    confirmReuse = false,
  ) {
    const preview = await this.preview(request)
    if (preview.hash !== expectedHash)
      throw new HttpError(409, 'conflict', 'The preview changed. Preview again before confirming.')
    if (preview.blockers.length) throw new HttpError(409, 'conflict', preview.blockers.join(' '))
    const reuse = preview.reusesName === true
    // An archive brings its own identity: importing over a retired name stays refused.
    if (reuse && imported)
      throw new HttpError(
        409,
        'conflict',
        'This name was used by a removed agent. Import under another name.',
      )
    if (reuse && !confirmReuse)
      throw new HttpError(400, 'bad_request', 'Confirm reusing the name first.')
    if (request.kind === 'create' && request.cloneFrom && !confirm)
      throw new HttpError(400, 'bad_request', 'Confirm what the new agent inherits first.')
    const id = randomUUID()
    const now = new Date(this.clock()).toISOString()
    const abandon =
      request.kind === 'delete' ? stoppedSetup(this.db.sqlite, preview.targetName) : null
    // Nothing to export or delete when the stopped setup never made the profile: only the Score-side retirement runs.
    const profileMissing =
      abandon !== null &&
      !ProfileInventorySchema.parse(await this.port.profileInventory(preview.targetName)).exists
    const input =
      request.kind === 'create'
        ? AgentCreateInputSchema.parse({
            id: request.id,
            name: redact(request.name),
            role: redact(request.role),
            style: request.style,
            model: request.model,
            ...(request.provider ? { provider: request.provider } : {}),
            ...(request.cloneFrom ? { cloneFrom: request.cloneFrom } : {}),
          })
        : null
    const operation = AgentOperationSchema.parse({
      id,
      kind: imported ? 'import' : request.kind,
      targetName: preview.targetName,
      // A reused name is a new agent: a new incarnation, never the removed one's.
      incarnationId: reuse
        ? randomUUID()
        : (lifecycleOf(this.db.sqlite, preview.targetName)?.incarnation_id ?? randomUUID()),
      requestHash: expectedHash,
      state: 'running',
      steps: (imported ? importSteps : request.kind === 'create' ? createSteps : deleteSteps).map(
        (name) => ({
          name,
          state: profileMissing && name !== 'retire' ? 'completed' : 'pending',
        }),
      ),
      createdAt: now,
      updatedAt: now,
      nextStep: imported
        ? 'import_profile'
        : request.kind === 'create'
          ? 'create_profile'
          : profileMissing
            ? 'retire'
            : 'export',
      error: null,
      exportPath: preview.exportPath,
    })
    const inventory = ProfileInventorySchema.parse(
      await this.port.profileInventory(preview.targetName),
    )
    await this.ingest.submit({
      source: 'profile-operations',
      identity: `begin:${id}`,
      apply: ({ sqlite }) => {
        // The stopped setup ends here, in the same transaction that starts the removal.
        if (abandon) {
          const held = sqlite
            .prepare(
              "SELECT operation FROM profile_operations WHERE id = ? AND state = 'needs_attention'",
            )
            .get(abandon.id) as { operation: string } | undefined
          if (!held)
            throw new HttpError(
              409,
              'conflict',
              'The setup changed. Preview again before removing.',
            )
          const stopped = JSON.parse(held.operation) as Record<string, unknown>
          sqlite
            .prepare(
              "UPDATE profile_operations SET operation = ?, state = 'completed' WHERE id = ?",
            )
            .run(
              JSON.stringify({ ...stopped, state: 'completed', abandoned: true, updatedAt: now }),
              abandon.id,
            )
        }
        if (
          sqlite
            .prepare(
              "SELECT id FROM profile_operations WHERE target_name = ? AND state != 'completed'",
            )
            .get(preview.targetName)
        )
          throw new HttpError(409, 'conflict', 'Another change to this agent is still in progress.')
        // Admission freezes and the busy recheck share the writer transaction with the journal.
        const busy = this.pending(preview.targetName)
        if (
          request.kind === 'delete' &&
          (busy.activeRuns || busy.queuedTurns || busy.pendingApprovals || busy.assignments)
        )
          throw new HttpError(
            409,
            'conflict',
            'This agent still has unfinished work. Finish or stop it first.',
          )
        sqlite
          .prepare(
            'INSERT INTO profile_operations (id, target_name, operation, request, target_identity, state) VALUES (?, ?, ?, ?, ?, ?)',
          )
          .run(
            id,
            preview.targetName,
            JSON.stringify(operation),
            JSON.stringify({
              input,
              baseline: readBaseline(sqlite),
              importUpload: imported?.uploadId ?? null,
            }),
            request.kind === 'delete' ? inventory.identity : null,
            'running',
          )
        sqlite
          .prepare(
            'INSERT INTO agent_lifecycle (agent_id, incarnation_id, state, operation_id, display_name) VALUES (?, ?, ?, ?, ?) ON CONFLICT(agent_id) DO UPDATE SET state = excluded.state, operation_id = excluded.operation_id, incarnation_id = excluded.incarnation_id, display_name = COALESCE(excluded.display_name, agent_lifecycle.display_name)',
          )
          .run(
            preview.targetName,
            operation.incarnationId,
            request.kind === 'create' ? 'setting_up' : 'deleting',
            id,
            input?.name ?? null,
          )
        // Whatever Score still held for the removed agent of this name (a pause from before 2.0.8) isn't the new one's.
        if (reuse)
          sqlite.prepare('DELETE FROM agent_pauses WHERE agent_id = ?').run(preview.targetName)
        // A reused name starts fresh: the removed agent's projection (role, skills, memory…) isn't the new one's.
        const previous = reuse ? null : readAgent(sqlite, preview.targetName)
        const agent =
          previous ??
          AgentDetailSchema.parse({
            id: preview.targetName,
            name: input!.name,
            role: input!.role,
            style: input!.style,
            status: 'offline',
            activity: 'Setting up',
            served: false,
            model: null,
            tagline: input!.role,
            personality: { excerpt: '', source: 'SOUL.md' },
            reportsTo: null,
            worksIn: null,
            rulesFile: null,
            skills: [],
            memory: [],
            tools: [],
            helpersMax: null,
            routines: [],
            channels: [],
            permissions: [],
          })
        if (input) writeAgentStyle(sqlite, input.id, input.style, now)
        storeAgent(sqlite, agent)
        return [
          { type: 'agent.updated', data: AgentSummarySchema.parse(applyLifecycle(sqlite, agent)) },
        ]
      },
    })
    this.launch(id)
    return operation
  }
  /**
   * Import an uploaded archive as a new agent. Hermes refuses an existing profile, so there is no replace: an
   * existing id is a blocker (delete the agent first, which keeps a private export).
   */
  async beginImport(
    request: AgentImportRequest,
    facts: { model: string | null; hasCredentials: boolean },
  ) {
    if (facts.hasCredentials && !request.confirmCredentials)
      throw new HttpError(
        400,
        'bad_request',
        'The archive contains credential files. Confirm that you want them copied into the new agent.',
      )
    // The model comes from the archive itself; the preview/begin machinery only needs a placeholder to validate.
    const create = {
      kind: 'create' as const,
      id: request.id,
      name: request.name,
      role: request.role,
      style: request.style,
      model: facts.model ?? 'from the archive',
    }
    const preview = await this.preview(create)
    return this.begin(create, preview.hash, false, { uploadId: request.uploadId })
  }
  /** Uploads still needed by an unfinished import must survive the stale-upload sweep. */
  sweepImports() {
    if (!this.imports) return
    const keep = new Set<string>()
    const rows = z
      .array(z.object({ request: z.string() }))
      .parse(
        this.db.sqlite
          .prepare("SELECT request FROM profile_operations WHERE state != 'completed'")
          .all(),
      )
    for (const row of rows) {
      const upload = StoredRequest.safeParse(JSON.parse(row.request))
      if (upload.success && upload.data.importUpload) keep.add(upload.data.importUpload)
    }
    this.imports.sweep(keep)
  }
  private launch(id: string) {
    if (this.closed || this.flights.has(id)) return
    // Let the accepted response and the Setting up event reach the browser before provisioning.
    const flight = new Promise<void>((resolve) => setImmediate(resolve))
      .then(() => this.run(id))
      .finally(() => this.flights.delete(id))
    this.flights.set(id, flight)
  }
  async recover() {
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
  }
  /**
   * A person retries a step that failed with a recorded error after fixing its cause. Only steps whose repeat is
   * harmless qualify; creating the profile and installing the plugin never run twice, and the delete only on the same
   * folder it began on (see `refresh`).
   */
  retry(id: string) {
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
  }
  /**
   * The person checked an interrupted step on the Hermes machine and says it finished. Only for steps Score lost track
   * of (never a recorded failure: "continue" after "profile already exists" would adopt someone else's profile), and
   * Score still checks what it can see: a created profile must exist, a deleted one must be gone.
   */
  async confirm(id: string, stepName: string) {
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
  }
  async refresh(id: string) {
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
  }
  private async deleteRetrySafe(operation: AgentOperation): Promise<boolean> {
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
  }
  private async save(operation: AgentOperation, identity?: string | null) {
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
  }
  private async run(id: string) {
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
  }
  /**
   * Team rules changed while the agent was being set up: apply the current rules to it and remember them as the
   * operation's baseline, so readiness is judged against the rules the agent actually has.
   */
  private async rebaseline(
    operation: AgentOperation,
    stored: z.infer<typeof StoredRequest>,
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
  }
  private async retire(operation: AgentOperation) {
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
  }
  async close() {
    this.closed = true
    await Promise.allSettled([...this.flights.values()])
  }
}
