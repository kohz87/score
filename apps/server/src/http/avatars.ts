import { randomUUID } from 'node:crypto'
import {
  AgentDetailSchema,
  AgentStyleSchema,
  AgentSummarySchema,
  AvatarRevSchema,
  ProfileNameSchema,
  type AgentDetail,
} from '@score/contract'
import type { FastifyInstance } from 'fastify'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import { humanGuard } from '../auth/human.ts'
import { AvatarStore } from '../avatars/store.ts'
import { AVATAR_TYPES, sniffAvatar } from '../avatars/sniff.ts'
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
import { parseSingleFile } from '../media/multipart.ts'
import { getCodingAgent } from '../runtimes/coding/store.ts'

const ParamsSchema = z.object({ agentId: ProfileNameSchema })
const QuerySchema = z.object({ rev: AvatarRevSchema })
/** A picture over 2 MB is refused with its reason; a body this far past that is not even read (413). */
const BODY_LIMIT = 16 * 1024 * 1024
const notFound = () => new HttpError(404, 'not_found', 'Couldn’t find that agent.')

/** Agent id → current picture revision, from the rows that name them (what start-up recovery keeps). */
export function currentAvatarRevs(sqlite: DatabaseSync): Map<string, string> {
  const rows = z.array(z.object({ id: z.string(), rev: AvatarRevSchema })).parse(
    sqlite
      .prepare(
        `SELECT agent_id AS id, avatar_rev AS rev FROM agent_styles WHERE avatar_rev IS NOT NULL
           UNION ALL
           SELECT id, avatar_rev AS rev FROM coding_agents WHERE avatar_rev IS NOT NULL AND removed_at IS NULL`,
      )
      .all(),
  )
  return new Map(rows.map((row) => [row.id, row.rev]))
}

/**
 * Agent pictures (PLAN 10.2, decision 105): PUT / DELETE / GET `/api/agents/:agentId/avatar`. The picture is data:
 * its type and size come from its bytes, it is stored under a random revision and served with its exact type.
 */
export function registerAvatarRoutes(
  app: FastifyInstance,
  deps: { port: HermesPort; db: ScoreDb; ingest: Ingest; store: AvatarStore },
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

  /** Sets (or clears) the picture revision of one agent. Returns the agent and the revision it replaced. */
  async function setRevision(agentId: string, rev: string | null) {
    let result: { agent: z.infer<typeof AgentSummarySchema>; previous: string | null } | undefined
    await ingest.submit({
      source: 'agent-avatar',
      identity: randomUUID(),
      apply({ sqlite, now }) {
        const detail = readAgent(sqlite, agentId)
        if (!live(detail)) throw notFound()
        const base = AgentStyleSchema.parse(
          readAgentStyle(sqlite, agentId) ?? getCodingAgent(sqlite, agentId)?.style ?? detail.style,
        )
        const previous = base.avatar ?? null
        const style = completeStyle({ ...base, avatar: rev })
        const agent = AgentDetailSchema.parse({ ...detail, style })
        result = { agent: AgentSummarySchema.parse(agent), previous }
        if (previous === rev) return []
        writeAgentStyle(sqlite, agentId, style, now, { avatar: true })
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
      { parseAs: 'buffer', bodyLimit: BODY_LIMIT + 64 * 1024 },
      (_request, body, done) => done(null, body),
    )
    scope.put(
      '/api/agents/:agentId/avatar',
      {
        bodyLimit: BODY_LIMIT + 64 * 1024,
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
        const file = parseSingleFile(request.body, request.headers['content-type'])
        await existing(agentId)
        const picture = sniffAvatar(file.bytes, file.filename)
        if (!picture.ok)
          throw new HttpError(
            422,
            'avatar_rejected',
            `That picture can’t be used: ${picture.reasons[0]}`,
            { reasons: picture.reasons },
          )
        const rev = store.write(agentId, picture.ext, file.bytes)
        let done
        try {
          done = await setRevision(agentId, rev)
        } catch (error) {
          store.remove(agentId, rev)
          throw error
        }
        if (done.previous) store.remove(agentId, done.previous)
        return done.agent
      },
    )
  })

  app.delete(
    '/api/agents/:agentId/avatar',
    { preHandler: [humanGuard(app.pairing)] },
    async (request) => {
      const { agentId } = ParamsSchema.parse(request.params)
      await existing(agentId)
      const done = await setRevision(agentId, null)
      if (done.previous) store.remove(agentId, done.previous)
      return done.agent
    },
  )

  app.get('/api/agents/:agentId/avatar', async (request, reply) => {
    const { agentId } = ParamsSchema.parse(request.params)
    const { rev } = QuerySchema.parse(request.query)
    const detail = readAgent(db.sqlite, agentId)
    if (!live(detail)) throw notFound()
    const style = readAgentStyle(db.sqlite, agentId) ?? getCodingAgent(db.sqlite, agentId)?.style
    // Only the current revision is served: an old URL of a replaced picture is gone with it.
    if ((style?.avatar ?? null) !== rev) throw notFound()
    const picture = store.read(agentId, rev)
    if (!picture) throw notFound()
    return reply
      .header('Content-Type', AVATAR_TYPES[picture.ext])
      .header('X-Content-Type-Options', 'nosniff')
      .header('Content-Disposition', 'inline')
      .header('Content-Security-Policy', "default-src 'none'; sandbox")
      .header('Cache-Control', 'private, max-age=31536000, immutable')
      .send(picture.bytes)
  })
}
