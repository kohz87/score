import { randomUUID } from 'node:crypto'
import { RewindRequestSchema, type RewindPlan, type RewindSkipReason } from '@score/contract'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { assertRoomFree } from '../../domain/orchestration/ownership.ts'
import { clearRoomHold, holdRoomUntil, persistRoomHold } from '../../domain/room-rewinding.ts'
import { roomRow } from '../../domain/rooms.ts'
import {
  createVersion,
  jobOfMessage,
  markRunsRewound,
  rewindableMessage,
  rewindScope,
  versionOfAnchor,
} from '../../domain/versions.ts'
import { HttpError } from '../../errors.ts'
import type { RoomRouteDeps } from './context.ts'
import { rewinding } from './rewind-guard.ts'
import { ParamsSchema } from './route-schemas.ts'

export function registerRewindRoutes(app: FastifyInstance, deps: RoomRouteDeps): void {
  const { db, ingest, port, mutation } = deps

  // Rewind (PLAN 5.33): the person's message and everything after it become a previous version, and the agents' Hermes
  // sessions go back to just before it. One rewind per room at a time.
  const MessageParamsSchema = z.object({
    roomId: ParamsSchema.shape.roomId,
    messageId: z.string().min(1).max(200),
  })
  async function rewindPlan(roomId: string, messageId: string) {
    const found = db.read((sqlite) => {
      const anchor = rewindableMessage(sqlite, roomId, messageId)
      return { anchor, scope: rewindScope(sqlite, roomId, anchor) }
    })
    const checks = await Promise.all(
      found.scope.agents.map(async (agent) => {
        const result = await port.rewindSession({
          agentId: agent.agentId,
          sessionId: agent.sessionId,
          turns: agent.turns,
          sinceMs: Date.parse(found.anchor.createdAt),
          dryRun: true,
        })
        return { agent, cannot: result.status === 'skipped' ? result.reason : null }
      }),
    )
    return { ...found, checks }
  }

  app.get(
    '/api/rooms/:roomId/messages/:messageId/rewind-plan',
    async (request): Promise<RewindPlan> => {
      const { roomId, messageId } = MessageParamsSchema.parse(request.params)
      const { scope, checks } = await rewindPlan(roomId, messageId)
      return {
        hiddenCount: scope.hiddenCount,
        blocked: scope.blocked,
        agents: checks.map(({ agent, cannot }) => ({
          agentId: agent.agentId,
          turns: agent.turns,
          cannot,
        })),
      }
    },
  )

  app.post('/api/rooms/:roomId/messages/:messageId/rewind', mutation, async (request) => {
    const { roomId, messageId } = MessageParamsSchema.parse(request.params)
    db.read((sqlite) => assertRoomFree(sqlite, roomId, 'message.rewind'))
    const body = RewindRequestSchema.strict().parse(request.body)
    const prior = db.read((sqlite) => {
      roomRow(sqlite, roomId)
      return versionOfAnchor(sqlite, roomId, messageId)
    })
    // Repeating a rewind that already happened returns what it did, and never touches Hermes again.
    if (prior) return { version: prior, rewound: prior.rewound, skipped: prior.skipped }
    if (rewinding.has(roomId))
      throw new HttpError(409, 'conflict', 'This room is already being rewound.')
    rewinding.add(roomId)
    // A command nobody answered may still be claimed by the plugin: the room stays held until it has expired.
    let uncertainUntil: number | null = null
    try {
      const { anchor, scope, checks } = await rewindPlan(roomId, messageId)
      if (scope.blocked) throw new HttpError(409, 'conflict', scope.blocked)
      const skipped: { agentId: string; reason: RewindSkipReason }[] = body.scoreOnly
        ? scope.agents.map((agent) => ({ agentId: agent.agentId, reason: 'score_only' }))
        : checks.flatMap(({ agent, cannot }) =>
            cannot ? [{ agentId: agent.agentId, reason: cannot }] : [],
          )
      if (!body.scoreOnly && skipped.length)
        throw new HttpError(409, 'rewind_incomplete', 'Some agents can’t be rewound.', {
          skipped,
          rewound: [],
        })
      const rewound: { agentId: string; turnsUndone: number }[] = []
      if (!body.scoreOnly) {
        for (const agent of scope.agents) {
          // Persisted before the command exists, so a restart can't release the room while it is still alive.
          let until = 0
          await ingest.submit({
            source: 'rooms',
            identity: randomUUID(),
            apply: ({ sqlite }) => {
              until = persistRoomHold(sqlite, roomId, Date.now())
              return []
            },
          })
          const result = await port.rewindSession({
            agentId: agent.agentId,
            sessionId: agent.sessionId,
            turns: agent.turns,
            sinceMs: Date.parse(anchor.createdAt),
          })
          if (result.status === 'skipped' && result.reason === 'no_answer') uncertainUntil = until
          if (result.status !== 'rewound') {
            const reason = result.status === 'skipped' ? result.reason : 'rewind_failed'
            throw new HttpError(409, 'rewind_incomplete', 'Some agents couldn’t be rewound.', {
              skipped: [{ agentId: agent.agentId, reason }],
              rewound,
            })
          }
          rewound.push({ agentId: agent.agentId, turnsUndone: result.turnsUndone })
          // Remembered at once: a retry after a later agent failed must not rewind this one again.
          await ingest.submit({
            source: 'rooms',
            identity: randomUUID(),
            apply: ({ sqlite, now }) => {
              markRunsRewound(
                sqlite,
                roomId,
                jobOfMessage(sqlite, anchor),
                agent.agentId,
                anchor.createdAt,
                now,
              )
              return []
            },
          })
        }
      }
      let created: ReturnType<typeof createVersion> | undefined
      await ingest.submit({
        source: 'rooms',
        identity: randomUUID(),
        apply: ({ sqlite, now }) => {
          // Re-checked inside the transaction: new work may have been queued while Hermes was being asked.
          const again = rewindScope(sqlite, roomId, anchor)
          if (again.blocked) throw new HttpError(409, 'conflict', again.blocked)
          created = createVersion(
            sqlite,
            {
              roomId,
              anchor,
              mode: body.mode,
              scoreOnly: Boolean(body.scoreOnly),
              rewound,
              skipped,
            },
            now,
          )
          return created.drafts
        },
      })
      return { version: created!.version, rewound, skipped }
    } finally {
      if (uncertainUntil !== null) holdRoomUntil(db.sqlite, roomId, uncertainUntil)
      else {
        rewinding.delete(roomId)
        clearRoomHold(db.sqlite, roomId)
      }
    }
  })
}
