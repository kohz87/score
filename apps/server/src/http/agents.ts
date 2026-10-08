import { AgentStyleSchema, AgentSummarySchema } from '@score/contract'
import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { humanGuard } from '../auth/human.ts'
import type { ScoreDb } from '../db/index.ts'
import { AgentDetailSchema } from '@score/contract'
import { readAgent, readAgentStyle, reconcileAgents, storeAgent } from '../domain/agents.ts'
import { unifiedDiff } from '../domain/line-diff.ts'
import { HttpError } from '../errors.ts'
import {
  AgentFileConflictError,
  AgentFileNameSchema,
  EtagSchema,
  assertFileContent,
  type HermesPort,
} from '../hermes/index.ts'
import type { Ingest } from '../hub/ingest.ts'
import { snapshot } from '../hub/snapshot.ts'
import { requestIdempotency } from './idempotency.ts'

const ParamsSchema = z.object({ agentId: z.string().min(1).max(256) })
const FileParamsSchema = ParamsSchema.extend({ file: z.string() })
const PreviewBodySchema = z.object({ content: z.string() }).strict()
const PutFileBodySchema = z.object({ content: z.string(), etag: EtagSchema }).strict()
const StylePatchSchema = AgentStyleSchema.partial()
  .strict()
  .refine((body) => Object.keys(body).length > 0)
export function registerAgentRoutes(
  app: FastifyInstance,
  port: HermesPort,
  ingest?: Ingest,
  db?: ScoreDb,
  clock = Date.now,
): void {
  function storage() {
    if (!db || !ingest)
      throw new HttpError(503, 'hermes_unavailable', 'Agent storage is unavailable')
    return { db, ingest }
  }
  async function refresh() {
    const { db, ingest } = storage()
    const details = z.array(AgentDetailSchema).parse(await port.listAgentDetails())
    await reconcileAgents(ingest, details)
    return { db, ids: details.map((agent) => agent.id) }
  }
  app.get('/api/agents', async () => {
    const { db, ids } = await refresh()
    const result = snapshot(db, (sqlite) =>
      ids.map((id) => AgentSummarySchema.parse(readAgent(sqlite, id))),
    )
    return { asOfSeq: result.asOfSeq, items: result.data }
  })
  app.get('/api/agents/:agentId', async (request) => {
    const { agentId } = ParamsSchema.parse(request.params)
    const { db, ids } = await refresh()
    if (!ids.includes(agentId)) throw new HttpError(404, 'not_found', 'Agent not found')
    return snapshot(db, (sqlite) => readAgent(sqlite, agentId)).data
  })
  const receipts = requestIdempotency(db, clock)
  app.patch(
    '/api/agents/:agentId/style',
    {
      preHandler: [humanGuard(app.pairing), receipts.preHandler],
      onSend: receipts.onSend,
    },
    async (request) => {
      const { agentId } = ParamsSchema.parse(request.params)
      const patch = StylePatchSchema.parse(request.body)
      const { ids } = await refresh()
      if (!ids.includes(agentId)) throw new HttpError(404, 'not_found', 'Agent not found')
      const { ingest } = storage()
      let response: z.infer<typeof AgentSummarySchema> | undefined
      await ingest.submit({
        source: 'agent-style',
        identity: randomUUID(),
        apply({ sqlite, now }) {
          const previous = readAgent(sqlite, agentId)
          if (!previous) throw new HttpError(404, 'not_found', 'Agent not found')
          const style = AgentStyleSchema.parse({
            ...(readAgentStyle(sqlite, agentId) ?? previous.style),
            ...patch,
          })
          const agent = AgentDetailSchema.parse({ ...previous, style })
          sqlite
            .prepare(
              'INSERT INTO agent_styles (agent_id, color, shape, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT (agent_id) DO UPDATE SET color = excluded.color, shape = excluded.shape, updated_at = excluded.updated_at',
            )
            .run(agentId, style.color, style.shape, now)
          storeAgent(sqlite, agent)
          response = AgentSummarySchema.parse(agent)
          return JSON.stringify(previous.style) === JSON.stringify(style)
            ? []
            : [{ type: 'agent.updated', data: response }]
        },
      })
      return response
    },
  )

  async function fileTarget(params: unknown) {
    const { agentId, file: name } = FileParamsSchema.parse(params)
    const file = AgentFileNameSchema.safeParse(name)
    if (!file.success) throw new HttpError(404, 'not_found', 'File not found')
    const ids = (await port.listAgents()).map((agent) => agent.id)
    if (!ids.includes(agentId)) throw new HttpError(404, 'not_found', 'Agent not found')
    return { agentId, file: file.data }
  }
  app.get('/api/agents/:agentId/files/:file', async (request) => {
    const { agentId, file } = await fileTarget(request.params)
    return port.readAgentFile(agentId, file)
  })
  app.post('/api/agents/:agentId/files/:file/preview', async (request) => {
    const { agentId, file } = await fileTarget(request.params)
    const { content } = PreviewBodySchema.parse(request.body)
    assertFileContent(content)
    const current = await port.readAgentFile(agentId, file)
    return { diff: unifiedDiff(current.content, content) }
  })
  app.put(
    '/api/agents/:agentId/files/:file',
    {
      preHandler: [humanGuard(app.pairing), receipts.preHandler],
      onSend: receipts.onSend,
    },
    async (request) => {
      const { agentId, file } = await fileTarget(request.params)
      const body = PutFileBodySchema.parse(request.body)
      const { ingest } = storage()
      let result: { etag: string }
      try {
        result = await port.writeAgentFile(agentId, file, body.content, body.etag)
      } catch (error) {
        if (!(error instanceof AgentFileConflictError)) throw error
        throw new HttpError(409, 'conflict', 'The file changed since you loaded it', {
          etag: error.current.etag,
          diff: unifiedDiff(error.current.content, body.content),
        })
      }
      // The personality excerpt / rules entry may have changed: refresh the projection and announce it.
      const detail = z
        .array(AgentDetailSchema)
        .parse(await port.listAgentDetails())
        .find((agent) => agent.id === agentId)
      if (detail)
        await ingest.submit({
          source: 'agent-file',
          identity: randomUUID(),
          apply({ sqlite }) {
            const agent = AgentDetailSchema.parse({
              ...detail,
              style: readAgentStyle(sqlite, agentId) ?? detail.style,
            })
            storeAgent(sqlite, agent)
            return [{ type: 'agent.updated', data: AgentSummarySchema.parse(agent) }]
          },
        })
      return result
    },
  )
}
