import { randomUUID } from 'node:crypto'
import { statSync } from 'node:fs'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import {
  OperationConfirmRequestSchema,
  AgentCreateRequestSchema,
  AgentDeleteRequestSchema,
  AgentPatchRequestSchema,
  AgentPreviewRequestSchema,
  AgentDetailSchema,
  AgentImportRequestSchema,
  ImportInspectionSchema,
  PROFILE_IMPORT_MAX_BYTES,
  ProfileImportUploadIdSchema,
  AgentSummarySchema,
  ProfileNameSchema,
} from '@score/contract'
import type { Config } from '../config.ts'
import type { ScoreDb } from '../db/index.ts'
import type { HermesPort } from '../hermes/index.ts'
import type { Ingest } from '../hub/ingest.ts'
import { humanGuard } from '../auth/human.ts'
import { HttpError } from '../errors.ts'
import { ProfileOperations } from '../domain/profiles.ts'
import { ProfileImportStore } from '../domain/profile-imports.ts'
import { inspectProfileArchive } from '../hermes/index.ts'
import { readAgent, reconcileAgents, storeAgent } from '../domain/agents.ts'
import { assertAgentAdmits, applyLifecycle } from '../domain/agent-lifecycle.ts'
import { redact } from '../redact.ts'
import { requestIdempotency } from './idempotency.ts'

export function registerProfileRoutes(
  app: FastifyInstance,
  deps: {
    db: ScoreDb
    ingest: Ingest
    port: HermesPort
    config: Config
    clock?: () => number
  },
) {
  const { db, ingest, port, config } = deps
  const imports = new ProfileImportStore(config.home, deps.clock)
  const operations = new ProfileOperations(db, ingest, port, deps.clock, imports)
  const receipts = requestIdempotency(db, deps.clock)
  // Creating agents writes API keys and deleting them removes data, so the transport must be private: loopback, or
  // remote mode over TLS (the only remote mode since 5.18; this stays as a second line of defence).
  const localOnly = async () => {
    if (!profileManagementAllowed(config))
      throw new HttpError(
        403,
        'feature_disabled',
        'Managing agents needs Score on this machine or an HTTPS connection (SCORE_TLS_CERT).',
      )
  }
  const mutation = {
    preHandler: [humanGuard(app.pairing), localOnly, receipts.preHandler],
    onSend: receipts.onSend,
  }
  const Params = z.object({ agentId: ProfileNameSchema })
  app.addHook('onReady', async () => {
    await operations.recover()
    operations.sweepImports()
  })
  app.addHook('preClose', async () => {
    await operations.close()
  })
  app.post('/api/agents/preview', mutation, async (request) => {
    await reconcileAgents(ingest, await port.listAgentDetails())
    // Reconcile task projections before counting unfinished assignments in the delete preview.
    const input = AgentPreviewRequestSchema.parse(request.body)
    if (input.kind === 'delete') await port.listTasks()
    return operations.preview(input)
  })
  const inspect = async (uploadId: string) => {
    const facts = await inspectProfileArchive(imports.pathFor(uploadId), PROFILE_IMPORT_MAX_BYTES)
    const suggested = ProfileNameSchema.safeParse(facts.root.toLowerCase())
    return {
      facts,
      view: ImportInspectionSchema.parse({
        uploadId,
        sizeBytes: statSync(imports.pathFor(uploadId)).size,
        archiveRoot: redact(facts.root).slice(0, 100),
        suggestedId: suggested.success && suggested.data !== 'default' ? suggested.data : null,
        description: facts.description,
        model: facts.model,
        configVersion: facts.configVersion,
        skills: facts.skills,
        plugins: facts.plugins,
        memoryBytes: facts.memoryBytes,
        fileCount: facts.fileCount,
        totalBytes: facts.totalBytes,
        credentialFiles: facts.credentialFiles,
        hasBridge: facts.hasBridge,
        warnings: facts.warnings,
      }),
    }
  }
  // The raw-body parser lives in its own scope so no other route accepts that content type.
  void app.register(async (scope) => {
    scope.addContentTypeParser(
      'application/octet-stream',
      { parseAs: 'buffer', bodyLimit: PROFILE_IMPORT_MAX_BYTES },
      (_request, body, done) => done(null, body),
    )
    // Before any body is read: an unpaired or remote-plain-HTTP caller can't make the server buffer 200 MiB.
    const gate = async (request: { headers: { cookie?: string | undefined } }) => {
      if (!app.pairing.isPaired(request.headers.cookie))
        throw new HttpError(
          401,
          'not_paired',
          'Pair this browser first. Open the pairing link shown in the server terminal.',
        )
      await localOnly()
    }
    scope.post(
      '/api/agents/imports',
      { bodyLimit: PROFILE_IMPORT_MAX_BYTES, onRequest: gate },
      async (request, reply) => {
        if (!Buffer.isBuffer(request.body))
          throw new HttpError(400, 'bad_request', 'Send the archive as application/octet-stream.')
        operations.sweepImports()
        const uploadId = imports.save(request.body)
        try {
          return reply.code(201).send((await inspect(uploadId)).view)
        } catch (error) {
          imports.remove(uploadId)
          throw error
        }
      },
    )
  })
  app.delete('/api/agents/imports/:uploadId', mutation, async (request, reply) => {
    const { uploadId } = z.object({ uploadId: ProfileImportUploadIdSchema }).parse(request.params)
    imports.remove(uploadId)
    return reply.code(204).send()
  })
  app.post('/api/agents/import', mutation, async (request, reply) => {
    const body = AgentImportRequestSchema.parse(request.body)
    if (!imports.exists(body.uploadId))
      throw new HttpError(404, 'not_found', 'The uploaded archive is gone. Upload it again.')
    // Inspect again: the stored file, not the earlier answer, decides the credential warning and the model.
    const { facts } = await inspect(body.uploadId)
    return reply.code(202).send(
      await operations.beginImport(body, {
        model: facts.model,
        hasCredentials: facts.credentialFiles.length > 0,
      }),
    )
  })
  app.post('/api/agents', mutation, async (request, reply) => {
    const { previewHash, confirmInheritance, ...input } = AgentCreateRequestSchema.parse(
      request.body,
    )
    return reply
      .code(202)
      .send(await operations.begin({ kind: 'create', ...input }, previewHash, confirmInheritance))
  })
  app.delete('/api/agents/:agentId', mutation, async (request, reply) => {
    const { agentId } = Params.parse(request.params)
    const body = AgentDeleteRequestSchema.parse(request.body)
    if (body.typedName !== agentId)
      throw new HttpError(400, 'bad_request', 'Type the agent’s exact profile name to delete it.')
    await port.listTasks()
    return reply
      .code(202)
      .send(await operations.begin({ kind: 'delete', agentId }, body.previewHash))
  })
  app.get(
    '/api/agents/operations/:opId',
    { preHandler: [humanGuard(app.pairing), localOnly] },
    async (request) => {
      const { opId } = z.object({ opId: z.uuid() }).parse(request.params)
      return operations.refresh(opId)
    },
  )
  app.post('/api/agents/operations/:opId/retry', mutation, async (request) => {
    const { opId } = z.object({ opId: z.uuid() }).parse(request.params)
    return operations.retry(opId)
  })
  app.post('/api/agents/operations/:opId/confirm', mutation, async (request) => {
    const { opId } = z.object({ opId: z.uuid() }).parse(request.params)
    const { step } = OperationConfirmRequestSchema.parse(request.body)
    return operations.confirm(opId, step)
  })
  app.patch('/api/agents/:agentId', mutation, async (request) => {
    const { agentId } = Params.parse(request.params)
    const body = AgentPatchRequestSchema.parse(request.body)
    await reconcileAgents(ingest, await port.listAgentDetails())
    if (!readAgent(db.sqlite, agentId))
      throw new HttpError(404, 'not_found', 'Couldn’t find that agent.')
    assertAgentAdmits(db.sqlite, agentId)
    // The form sends both fields; a description that did not change costs no Hermes process.
    if (body.role && body.role !== readAgent(db.sqlite, agentId)?.role) {
      await port.describeProfile(agentId, body.role)
      await reconcileAgents(ingest, await port.listAgentDetails())
    }
    let response: z.infer<typeof AgentDetailSchema> | undefined
    await ingest.submit({
      source: 'profile-description',
      identity: randomUUID(),
      apply: ({ sqlite }) => {
        assertAgentAdmits(sqlite, agentId)
        const previous = readAgent(sqlite, agentId)!
        if (body.name) {
          sqlite
            .prepare(
              'INSERT INTO agent_lifecycle (agent_id, incarnation_id, state, display_name) VALUES (?, ?, ?, ?) ON CONFLICT(agent_id) DO UPDATE SET display_name = excluded.display_name',
            )
            .run(agentId, randomUUID(), 'ready', redact(body.name))
        }
        response = AgentDetailSchema.parse(
          applyLifecycle(sqlite, {
            ...previous,
            ...(body.role ? { role: redact(body.role), tagline: redact(body.role) } : {}),
          }),
        )
        storeAgent(sqlite, response)
        return [{ type: 'agent.updated', data: AgentSummarySchema.parse(response) }]
      },
    })
    return response
  })
}

export function profileManagementAllowed(config: Pick<Config, 'host' | 'remote'>): boolean {
  const loopback = ['localhost', '127.0.0.1', '::1'].includes(config.host)
  return loopback || Boolean(config.remote?.tlsCert)
}
