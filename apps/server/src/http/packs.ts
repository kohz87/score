import { randomUUID } from 'node:crypto'
import {
  AgentDetailSchema,
  AgentStyleSchema,
  AgentSummarySchema,
  PackRevSchema,
  PetActivitySchema,
  ProfileNameSchema,
  type AgentDetail,
  type PetPack,
} from '@score/contract'
import type { FastifyInstance } from 'fastify'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { humanGuard } from '../auth/human.ts'
import type { ScoreDb } from '../db/index.ts'
import {
  completeStyle,
  readAgent,
  readAgentStyle,
  reconcileAgents,
  storeAgent,
  writeAgentStyle,
} from '../domain/agents.ts'
import { HttpError } from '../errors.ts'
import type { HermesPort } from '../hermes/index.ts'
import type { Ingest } from '../hub/ingest.ts'
import { parseFiles } from '../media/multipart.ts'
import { parsePack } from '../packs/meta.ts'
import { PackRejected, readPack } from '../packs/reader.ts'
import { PACK_TYPES } from '../packs/sniff.ts'
import type { PackStore } from '../packs/store.ts'
import { getCodingAgent } from '../runtimes/coding/store.ts'

const ParamsSchema = z.object({ agentId: ProfileNameSchema })
const ImageParamsSchema = ParamsSchema.extend({ activity: z.string().min(1).max(32) })
const QuerySchema = z.object({ rev: PackRevSchema })
/** A pack is up to 256 MB unpacked; a body this far past that is not even read (413). */
const BODY_LIMIT = 264 * 1024 * 1024
const MAX_PARTS = 64
const notFound = () => new HttpError(404, 'not_found', 'Couldn’t find that agent.')

/** Agent id → revision of its current pack, from the rows that name a valid one (what start-up recovery keeps). */
export function currentPackRevs(sqlite: DatabaseSync): Map<string, string> {
  const rows = z
    .array(z.object({ id: z.string(), rev: z.string().nullable(), meta: z.string().nullable() }))
    .parse(
      sqlite
        .prepare(
          `SELECT agent_id AS id, pack_rev AS rev, pack_meta AS meta FROM agent_styles WHERE pack_rev IS NOT NULL
           UNION ALL
           SELECT id, pack_rev AS rev, pack_meta AS meta FROM coding_agents WHERE pack_rev IS NOT NULL AND removed_at IS NULL`,
        )
        .all(),
    )
  const revs = new Map<string, string>()
  for (const row of rows) if (parsePack(row.rev, row.meta)) revs.set(row.id, row.rev!)
  return revs
}

/**
 * Pet packs (PLAN 10.2, decisions 107-108): PUT / DELETE `/api/agents/:agentId/pack` and GET
 * `/api/agents/:agentId/pack/:activity?rev=`. A pack is data: Score reads its images and `pet.json` and nothing in it
 * runs; its files are stored under a random revision and served with their exact type.
 */
export function registerPackRoutes(
  app: FastifyInstance,
  deps: { port: HermesPort; db: ScoreDb; ingest: Ingest; store: PackStore },
): void {
  const { port, db, ingest, store } = deps
  const live = (agent: AgentDetail | null): agent is AgentDetail =>
    agent !== null && !['removed', 'deleting'].includes(agent.lifecycle?.state ?? 'ready')

  async function existing(agentId: string): Promise<void> {
    let agent = readAgent(db.sqlite, agentId)
    if (!agent) {
      // Not projected yet (a fresh start, before the first agent list).
      await reconcileAgents(ingest, z.array(AgentDetailSchema).parse(await port.listAgentDetails()))
      agent = readAgent(db.sqlite, agentId)
    }
    if (!live(agent)) throw notFound()
  }

  /** Sets (or clears) the pack of one agent in one step. Returns the agent and the pack it replaced. */
  async function change(agentId: string, pack: PetPack | null) {
    let result: { agent: z.infer<typeof AgentSummarySchema>; previous: PetPack | null } | undefined
    await ingest.submit({
      source: 'agent-pack',
      identity: randomUUID(),
      apply({ sqlite, now }) {
        const detail = readAgent(sqlite, agentId)
        if (!live(detail)) throw notFound()
        const base = completeStyle(
          AgentStyleSchema.parse(
            readAgentStyle(sqlite, agentId) ??
              getCodingAgent(sqlite, agentId)?.style ??
              detail.style,
          ),
        )
        const style = completeStyle({ ...base, pack })
        const agent = AgentDetailSchema.parse({ ...detail, style })
        result = { agent: AgentSummarySchema.parse(agent), previous: base.pack }
        if (JSON.stringify(style) === JSON.stringify(base)) return []
        writeAgentStyle(sqlite, agentId, style, now, { pack: true })
        storeAgent(sqlite, agent)
        return [{ type: 'agent.updated', data: result.agent }]
      },
    })
    return result!
  }

  // The multipart parser lives in its own scope so no other route accepts that content type.
  void app.register(async (scope) => {
    scope.addContentTypeParser(
      'multipart/form-data',
      { parseAs: 'buffer', bodyLimit: BODY_LIMIT },
      (_request, body, done) => done(null, body),
    )
    scope.put(
      '/api/agents/:agentId/pack',
      {
        bodyLimit: BODY_LIMIT,
        // Before the body is read, so an unpaired caller can't make the server buffer megabytes.
        onRequest: async (request) => {
          if (!app.pairing.isPaired(request.headers.cookie))
            throw new HttpError(
              401,
              'not_paired',
              'Pair this browser first. Open the pairing link shown in the server terminal.',
            )
        },
        preHandler: [humanGuard(app.pairing)],
      },
      async (request) => {
        const { agentId } = ParamsSchema.parse(request.params)
        if (!Buffer.isBuffer(request.body))
          throw new HttpError(400, 'bad_request', 'Couldn’t read that upload. Try again.')
        const parts = parseFiles(request.body, request.headers['content-type'], MAX_PARTS)
        await existing(agentId)
        let read
        try {
          read = readPack(parts.map((part) => ({ name: part.filename, bytes: part.bytes })))
        } catch (error) {
          if (error instanceof PackRejected)
            throw new HttpError(
              422,
              'pack_rejected',
              `That pack can’t be used: ${error.reasons[0]}`,
              { reasons: error.reasons },
            )
          throw error
        }
        const rev = store.write(agentId, read.files)
        const pack: PetPack = {
          rev,
          activities: read.files.map((file) => file.activity),
          name: read.manifest.name ?? null,
          credits: read.manifest.credits ?? null,
          floor: read.manifest.floor ?? 0,
        }
        let done
        try {
          done = await change(agentId, pack)
        } catch (error) {
          store.remove(agentId, rev)
          throw error
        }
        if (done.previous) store.remove(agentId, done.previous.rev)
        return { agent: done.agent, ignored: read.ignored }
      },
    )
  })

  app.delete(
    '/api/agents/:agentId/pack',
    { preHandler: [humanGuard(app.pairing)] },
    async (request) => {
      const { agentId } = ParamsSchema.parse(request.params)
      await existing(agentId)
      const done = await change(agentId, null)
      if (done.previous) store.remove(agentId, done.previous.rev)
      return done.agent
    },
  )

  app.get('/api/agents/:agentId/pack/:activity', async (request, reply) => {
    const { agentId, activity } = ImageParamsSchema.parse(request.params)
    const { rev } = QuerySchema.parse(request.query)
    const detail = readAgent(db.sqlite, agentId)
    if (!live(detail)) throw notFound()
    const style = readAgentStyle(db.sqlite, agentId) ?? getCodingAgent(db.sqlite, agentId)?.style
    const pack = style?.pack ?? null
    // Only the current revision is served, and only the activities it has.
    const known = PetActivitySchema.safeParse(activity)
    if (!pack || pack.rev !== rev || !known.success || !pack.activities.includes(known.data))
      throw new HttpError(404, 'not_found', 'Couldn’t find that animation.')
    const file = store.read(agentId, rev, known.data)
    if (!file) throw new HttpError(404, 'not_found', 'Couldn’t find that animation.')
    return reply
      .header('Content-Type', PACK_TYPES[file.ext])
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Disposition', 'inline')
      .header('Content-Security-Policy', "default-src 'none'; sandbox")
      .header('Cache-Control', 'private, max-age=31536000, immutable')
      .send(file.bytes)
  })
}
