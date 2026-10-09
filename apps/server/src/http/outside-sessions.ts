import { randomUUID } from 'node:crypto'
import {
  ContinueSessionResponseSchema,
  ImportSessionRequestSchema,
  ImportSessionResponseSchema,
  OutsideSessionsResponseSchema,
} from '@score/contract'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { humanGuard } from '../auth/human.ts'
import type { ScoreDb } from '../db/index.ts'
import { agentAdmits } from '../domain/agent-lifecycle.ts'
import {
  importOutsideSession,
  importedRooms,
  sessionSummary,
  setContinuation,
} from '../domain/outside-sessions.ts'
import { roomRow } from '../domain/rooms.ts'
import { HttpError } from '../errors.ts'
import type { HermesPort } from '../hermes/index.ts'
import type { Ingest } from '../hub/ingest.ts'

const RoomParams = z.object({ roomId: z.string().min(1).max(256) })
const ImportedFromSchema = z.object({
  agentId: z.string().min(1),
  sessionId: z.string().min(1),
  source: z.string().min(1),
  label: z.string().min(1),
})

// Hermes sessions that Score did not start (PLAN 5.26): list, import as a read-only room, continue in that room.
// Hermes' databases are only read, through the adapter.
export function registerOutsideSessionRoutes(
  app: FastifyInstance,
  deps: { db: ScoreDb; ingest: Ingest; port: HermesPort },
): void {
  const { db, ingest, port } = deps
  const guard = { preHandler: [humanGuard(app.pairing)] }

  async function agentIds() {
    const agents = await port.listAgents()
    return agents.filter((agent) => agentAdmits(db.sqlite, agent.id)).map((agent) => agent.id)
  }

  app.get('/api/outside-sessions', async () => {
    const found = await port.listOutsideSessions(await agentIds())
    const rooms = db.read((sqlite) => importedRooms(sqlite))
    return OutsideSessionsResponseSchema.parse({
      items: found.items.map((item) => ({
        ...item,
        roomId: rooms.get(`${item.agentId}\0${item.id}`) ?? null,
      })),
      unavailable: found.unavailable,
    })
  })

  app.post('/api/outside-sessions/import', guard, async (request) => {
    const body = ImportSessionRequestSchema.parse(request.body)
    if (!(await agentIds()).includes(body.agentId))
      throw new HttpError(404, 'not_found', 'Unknown agent')
    const history = await port.readOutsideSession(body.agentId, body.sessionId)
    if (!history) throw new HttpError(404, 'not_found', 'That session is no longer available')
    let result: { roomId: string; imported: number } | undefined
    await ingest.submit({
      source: 'rooms',
      identity: randomUUID(),
      apply({ sqlite, now }) {
        const made = importOutsideSession(sqlite, history, now)
        result = { roomId: made.roomId, imported: made.imported }
        return made.events
      },
    })
    return ImportSessionResponseSchema.parse(result)
  })

  app.post('/api/rooms/:roomId/continue-session', guard, async (request) => {
    const { roomId } = RoomParams.parse(request.params)
    const row = db.read((sqlite) => roomRow(sqlite, roomId))
    if (!row.imported_from) throw new HttpError(409, 'conflict', 'This room was not imported')
    const from = ImportedFromSchema.parse(JSON.parse(row.imported_from))
    const history = await port.readOutsideSession(from.agentId, from.sessionId)
    if (!history) throw new HttpError(404, 'not_found', 'That session is no longer available')
    // Never run inside a session another surface may be writing to right now.
    if (history.session.busy)
      throw new HttpError(
        409,
        'session_busy',
        `This session is still active on ${from.label}. Try again when it has been quiet for a few minutes.`,
      )
    const mode = port.sessionContinuation()
    await ingest.submit({
      source: 'rooms',
      identity: randomUUID(),
      apply: ({ sqlite, now }) =>
        setContinuation(
          sqlite,
          roomId,
          mode,
          mode === 'new_session' ? sessionSummary(sqlite, roomId, from.label) : null,
          now,
        ),
    })
    return ContinueSessionResponseSchema.parse({ mode })
  })
}
