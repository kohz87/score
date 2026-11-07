import { randomUUID } from 'node:crypto'
import {
  AgentCreateInputSchema,
  AgentDetailSchema,
  AgentOperationSchema,
  AgentSummarySchema,
  type AgentImportRequest,
  type AgentPreviewRequest,
} from '@score/contract'
import { z } from 'zod'
import { HttpError } from '../errors.ts'
import { ProfileInventorySchema } from '../hermes/index.ts'
import { redact } from '../redact.ts'
import { readAgent, storeAgent, writeAgentStyle } from './agents.ts'
import { applyLifecycle, lifecycleOf } from './agent-lifecycle.ts'
import type { ProfileOperationsRuntime } from './profiles-runtime.ts'
import {
  StoredRequest,
  createSteps,
  deleteSteps,
  importSteps,
  stoppedSetup,
} from './profiles-support.ts'
import { readBaseline } from './team-rules.ts'

export const beginMethods = {
  async begin(
    this: ProfileOperationsRuntime,
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
  },
  /**
   * Import an uploaded archive as a new agent. Hermes refuses an existing profile, so there is no replace: an
   * existing id is a blocker (delete the agent first, which keeps a private export).
   */
  async beginImport(
    this: ProfileOperationsRuntime,
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
  },
  /** Uploads still needed by an unfinished import must survive the stale-upload sweep. */
  sweepImports(this: ProfileOperationsRuntime) {
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
  },
}

export type BeginMethods = typeof beginMethods
