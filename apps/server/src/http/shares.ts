import { randomUUID } from 'node:crypto'
import { ShareCreateRequestSchema, ShareCreatedSchema, SharesResponseSchema } from '@score/contract'
import type { FastifyInstance, FastifyReply } from 'fastify'
import { z } from 'zod'
import { humanGuard } from '../auth/human.ts'
import type { SecurityPassword } from '../auth/security-password.ts'
import type { ScoreDb } from '../db/index.ts'
import { roomRow } from '../domain/rooms.ts'
import {
  buildShareSnapshot,
  countView,
  findLiveShare,
  hashShareToken,
  insertShare,
  listShares,
  newShareToken,
  revokeShare,
} from '../domain/shares.ts'
import { HttpError } from '../errors.ts'
import type { HermesPort } from '../hermes/index.ts'
import type { MediaStore } from '../media/store.ts'
import { NOT_FOUND_PAGE, renderSharePage, SHARE_HEADERS, TOO_MANY_PAGE } from '../shares/page.ts'
import { RateLimiter } from '../shares/rate-limit.ts'
import { sessionKey } from './session.ts'

const DAY_MS = 24 * 60 * 60 * 1000
const RoomParams = z.object({ roomId: z.string().min(1).max(256) })

function sharePage(reply: FastifyReply, status: number, html: string) {
  reply.code(status).header('content-type', 'text/html; charset=utf-8')
  for (const [name, value] of Object.entries(SHARE_HEADERS)) reply.header(name, value)
  return reply.send(html)
}

/**
 * Share links (PLAN 5.26, lead's security design). Creating, listing and revoking are for paired browsers (creating
 * also needs the security password). `GET /s/:token` is the only unauthenticated route: a frozen, redacted snapshot as
 * static server-rendered HTML with a locked-down CSP, rate-limited per IP. Unknown, expired and revoked links look the same.
 */
export function registerShareRoutes(
  app: FastifyInstance,
  deps: {
    db: ScoreDb
    port: HermesPort
    security: SecurityPassword | undefined
    media: MediaStore | undefined
    /** Where people open Score (the public origin); links are `<origin>/s/<token>`. */
    origin: string
    clock?: () => number
  },
): void {
  const { db, port, security, media, origin } = deps
  const clock = deps.clock ?? Date.now
  const guard = { preHandler: [humanGuard(app.pairing)] }
  const limiter = new RateLimiter(30, 60_000, clock)
  // A page can show many images; they must not spend the page's budget (the token check still bounds guessing).
  const mediaLimiter = new RateLimiter(600, 60_000, clock)

  // No Idempotency-Key receipt here: the body carries the password and a replay would hand out a second token.
  app.post('/api/rooms/:roomId/shares', guard, async (request) => {
    const { roomId } = RoomParams.parse(request.params)
    const body = ShareCreateRequestSchema.parse(request.body)
    if (!security) throw new HttpError(501, 'unsupported', 'Share links are not available here')
    await security.verify(body.password, sessionKey(request.headers.cookie))
    db.read((sqlite) => roomRow(sqlite, roomId))
    const agents = await port.listAgents().catch(() => [])
    const names = new Map(agents.map((agent) => [agent.id, agent.name]))
    const token = newShareToken()
    const now = clock()
    const id = randomUUID()
    const expiresAt = new Date(now + body.expiresInDays * DAY_MS).toISOString()
    db.tx((sqlite) =>
      insertShare(sqlite, {
        id,
        roomId,
        tokenHash: hashShareToken(token),
        createdAt: new Date(now).toISOString(),
        expiresAt,
        includeImages: body.includeImages,
        snapshot: buildShareSnapshot(sqlite, roomId, names, body.includeImages),
      }),
    )
    return ShareCreatedSchema.parse({ id, url: `${origin}/s/${token}`, expiresAt })
  })

  const now = () => new Date(clock()).toISOString()
  app.get('/api/shares', guard, async () =>
    SharesResponseSchema.parse({ items: db.read((sqlite) => listShares(sqlite, now())) }),
  )
  app.get('/api/rooms/:roomId/shares', guard, async (request) => {
    const { roomId } = RoomParams.parse(request.params)
    return SharesResponseSchema.parse({
      items: db.read((sqlite) => listShares(sqlite, now(), roomId, true)),
    })
  })
  app.delete('/api/shares/:id', guard, async (request, reply) => {
    const { id } = z.object({ id: z.string().min(1).max(200) }).parse(request.params)
    if (!db.tx((sqlite) => revokeShare(sqlite, id, now())))
      throw new HttpError(404, 'not_found', 'Unknown share')
    return reply.code(204).send()
  })

  // Public routes. Nothing here throws a JSON error: every failure is the same static page.
  app.get('/s/:token', async (request, reply) => {
    if (!limiter.allow(request.ip)) return sharePage(reply, 429, TOO_MANY_PAGE)
    const { token } = request.params as { token: string }
    const share = db.read((sqlite) => findLiveShare(sqlite, token, now()))
    if (!share) return sharePage(reply, 404, NOT_FOUND_PAGE)
    countView(db.sqlite, share.id)
    return sharePage(reply, 200, renderSharePage(share.parsed, token, share.expires_at))
  })

  app.get('/s/:token/media/:n', async (request, reply) => {
    if (!mediaLimiter.allow(request.ip)) return sharePage(reply, 429, TOO_MANY_PAGE)
    const { token, n } = request.params as { token: string; n: string }
    const share = db.read((sqlite) => findLiveShare(sqlite, token, now()))
    const index = /^\d{1,4}$/.test(n) ? Number(n) : -1
    const mediaId = share?.include_images === 1 ? share.parsed.images[index] : undefined
    const stored = mediaId && media ? media.read(mediaId) : null
    if (!stored) return sharePage(reply, 404, NOT_FOUND_PAGE)
    for (const [name, value] of Object.entries(SHARE_HEADERS)) reply.header(name, value)
    return reply
      .header('content-type', stored.contentType)
      .header('content-disposition', 'inline')
      .send(stored.bytes)
  })
}
