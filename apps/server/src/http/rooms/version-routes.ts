import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { listVersions, versionMessages, versionOfAnchor } from '../../domain/versions.ts'
import { HttpError } from '../../errors.ts'
import { snapshot } from '../../hub/snapshot.ts'
import type { RoomRouteDeps } from './context.ts'
import { ParamsSchema } from './route-schemas.ts'

export function registerVersionRoutes(app: FastifyInstance, deps: RoomRouteDeps): void {
  const { db } = deps

  app.get('/api/rooms/:roomId/versions', async (request) => {
    const { roomId } = ParamsSchema.parse(request.params)
    const result = snapshot(db, (sqlite) => listVersions(sqlite, roomId))
    return { asOfSeq: result.asOfSeq, items: result.data }
  })

  app.get('/api/rooms/:roomId/versions/:anchorId', async (request) => {
    const { roomId, anchorId } = z
      .object({ roomId: ParamsSchema.shape.roomId, anchorId: z.string().min(1).max(200) })
      .parse(request.params)
    return db.read((sqlite) => {
      const version = versionOfAnchor(sqlite, roomId, anchorId)
      if (!version) throw new HttpError(404, 'not_found', 'Couldn’t find that version.')
      return { version, items: versionMessages(sqlite, version.id) }
    })
  })
}
