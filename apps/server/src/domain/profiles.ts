import { createHash, randomUUID } from 'node:crypto'
import { z } from 'zod'
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
import { readAgent, reconcileAgents, storeAgent } from './agents.ts'
import { applyLifecycle, lifecycleOf } from './agent-lifecycle.ts'
import type { ProfileImportStore } from './profile-imports.ts'
import { readBaseline } from './team-rules.ts'
import { roomChanged, RoomRowSchema } from './rooms.ts'

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
    if (!row) throw new HttpError(404, 'not_found', 'Operation not found')
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
    if (name === 'default') blockers.push('The default profile is reserved.')
    if (request.kind === 'create') {
      if (inventory.exists)
        blockers.push(
          'A profile with this name already exists; Score never adopts it automatically.',
        )
      if (lifecycle?.state === 'removed')
        blockers.push('This name is retired and cannot be reused.')
    } else {
      if (!inventory.exists || lifecycle?.state === 'removed') blockers.push('Agent not found.')
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
    if (lifecycle && !['ready', 'removed'].includes(lifecycle.state))
      blockers.push('An operation already holds this agent.')
    let providerLabel = request.kind === 'create' ? (request.provider ?? '') : ''
    if (request.kind === 'create' && request.provider) {
      const match = (await this.port.listModels(request.model).catch(() => [])).find(
        (item) => item.provider === request.provider && item.model === request.model,
      )
      if (match) providerLabel = match.providerLabel
    }
    const exportPath =
      request.kind === 'delete' ? this.port.profileExportPath(name, inventory.revision) : null
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
            ]
          : [
              'Freeze new admissions, export privately, delete and purge profile identity, then retire routing references.',
              'The export omits credentials and is not a full undo. It may contain sensitive conversations and is kept privately until you remove it locally.',
            ],
      blockers,
      pendingWork,
      exportPath,
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
  ) {
    const preview = await this.preview(request)
    if (preview.hash !== expectedHash)
      throw new HttpError(409, 'conflict', 'The preview changed. Preview again before confirming.')
    if (preview.blockers.length) throw new HttpError(409, 'conflict', preview.blockers.join(' '))
    if (request.kind === 'create' && request.cloneFrom && !confirm)
      throw new HttpError(400, 'bad_request', 'Confirm the inherited data and capabilities first')
    const id = randomUUID()
    const now = new Date(this.clock()).toISOString()
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
      incarnationId:
        lifecycleOf(this.db.sqlite, preview.targetName)?.incarnation_id ?? randomUUID(),
      requestHash: expectedHash,
      state: 'running',
      steps: (imported ? importSteps : request.kind === 'create' ? createSteps : deleteSteps).map(
        (name) => ({
          name,
          state: 'pending',
        }),
      ),
      createdAt: now,
      updatedAt: now,
      nextStep: imported
        ? 'import_profile'
        : request.kind === 'create'
          ? 'create_profile'
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
        if (
          sqlite
            .prepare(
              "SELECT id FROM profile_operations WHERE target_name = ? AND state != 'completed'",
            )
            .get(preview.targetName)
        )
          throw new HttpError(409, 'conflict', 'An operation already holds this agent')
        // Admission freezes and the busy recheck share the writer transaction with the journal.
        const busy = this.pending(preview.targetName)
        if (
          request.kind === 'delete' &&
          (busy.activeRuns || busy.queuedTurns || busy.pendingApprovals || busy.assignments)
        )
          throw new HttpError(409, 'conflict', 'Agent has pending work')
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
            'INSERT INTO agent_lifecycle (agent_id, incarnation_id, state, operation_id, display_name) VALUES (?, ?, ?, ?, ?) ON CONFLICT(agent_id) DO UPDATE SET state = excluded.state, operation_id = excluded.operation_id',
          )
          .run(
            preview.targetName,
            operation.incarnationId,
            request.kind === 'create' ? 'setting_up' : 'deleting',
            id,
            input?.name ?? null,
          )
        const previous = readAgent(sqlite, preview.targetName)
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
        if (input)
          sqlite
            .prepare(
              'INSERT INTO agent_styles (agent_id, color, shape, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(agent_id) DO UPDATE SET color=excluded.color, shape=excluded.shape, updated_at=excluded.updated_at',
            )
            .run(input.id, input.style.color, input.style.shape, now)
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
   * harmless qualify; creating the profile, installing the plugin and the delete itself never run twice.
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
        'This step cannot be retried from Score. Check the profile locally first.',
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
      throw new HttpError(409, 'conflict', 'This step cannot be confirmed from Score.')
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
        throw new HttpError(409, 'conflict', 'The profile does not exist, so it was not created.')
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
  refresh(id: string) {
    const operation = this.get(id)
    if (operation.state === 'needs_attention' && operation.nextStep === 'verify_ready')
      this.launch(id)
    return operation
  }
  private async save(operation: AgentOperation, identity?: string | null) {
    await this.ingest.submit({
      source: 'profile-operations',
      identity: randomUUID(),
      apply: ({ sqlite }) => {
        sqlite
          .prepare(
            'UPDATE profile_operations SET operation = ?, state = ?, target_identity = COALESCE(?, target_identity) WHERE id = ?',
          )
          .run(JSON.stringify(operation), operation.state, identity ?? null, operation.id)
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
            return [{ type: 'agent.updated', data: AgentSummarySchema.parse(agent) }]
          }
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
              'Work appeared after admissions were frozen. Finish it before the next step.',
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
          throw new HttpError(409, 'conflict', 'Profile identity changed before activation')
        await this.rebaseline(operation, stored, identity)
        if (JSON.stringify(readBaseline(this.db.sqlite)) !== JSON.stringify(stored.baseline))
          throw new HttpError(
            409,
            'conflict',
            'Team rules changed during provisioning. Reapply the current team rules before activation.',
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
          'A replacement profile appeared before retirement. Inspect its identity locally.',
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
      await this.save(operation, identity)
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
        const rooms = z.array(RoomRowSchema).parse(sqlite.prepare('SELECT * FROM rooms').all())
        const events = []
        for (const room of rooms) {
          const members = z
            .array(z.string())
            .parse(JSON.parse(room.members))
            .filter((id) => id !== operation.targetName)
          if (
            room.lead_agent_id !== operation.targetName &&
            members.length === JSON.parse(room.members).length
          )
            continue
          sqlite
            .prepare(
              'UPDATE rooms SET members = ?, lead_agent_id = CASE WHEN lead_agent_id = ? THEN NULL ELSE lead_agent_id END, updated_at = ? WHERE id = ?',
            )
            .run(JSON.stringify(members), operation.targetName, now, room.id)
          events.push(...roomChanged(sqlite, room.id, now))
        }
        sqlite
          .prepare(
            "UPDATE message_runs SET state = 'failed' WHERE agent_id = ? AND state = 'pending'",
          )
          .run(operation.targetName)
        sqlite
          .prepare('DELETE FROM agent_rule_overrides WHERE agent_id = ?')
          .run(operation.targetName)
        // Credential files and backups are retained privately; invalidate generations and bridge tokens in Score.
        sqlite.prepare('DELETE FROM credentials WHERE profile = ?').run(operation.targetName)
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
