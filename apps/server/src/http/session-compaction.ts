import { randomUUID } from 'node:crypto'
import {
  AgentSummarySchema,
  CompactRequestSchema,
  SessionContextSchema,
  type CompactFailureReason,
  type SessionCompacted,
  type SessionContext,
} from '@score/contract'
import type { FastifyInstance, preHandlerHookHandler, onSendHookHandler } from 'fastify'
import { z } from 'zod'
import type { ScoreDb } from '../db/index.ts'
import { assertRoomFree } from '../domain/orchestration/ownership.ts'
import { compactingKey, compactingSessions, rewindingRooms } from '../domain/room-rewinding.ts'
import { HttpError } from '../errors.ts'
import type { HermesPort } from '../hermes/index.ts'
import type { Ingest } from '../hub/ingest.ts'
import { headSeq } from '../hub/snapshot.ts'
import { readAgentContext } from './agent-context.ts'

const ParamsSchema = z.object({
  agentId: z.string().min(1).max(256),
  sessionId: z.string().min(1).max(256),
})
const CACHE_MS = 30_000

/**
 * Compaction and the context meter of one room session (PLAN 5.36, contract §4 "Agents"): the session is
 * `score-<roomId>-<agentId>` or the Hermes session an imported room continues. Hermes does the work inside the agent's
 * gateway through the bridge; Score only asks, holds the agent's turns in that room meanwhile, and reports.
 */
export function registerSessionCompactionRoutes(
  app: FastifyInstance,
  deps: {
    port: HermesPort
    db: ScoreDb
    ingest: Ingest
    mutation: { preHandler: preHandlerHookHandler[]; onSend: onSendHookHandler }
    /** Starts the turns that waited for the compaction. */
    redispatch(): Promise<unknown>
    clock?: () => number
  },
): void {
  const { port, db, ingest, mutation } = deps
  const clock = deps.clock ?? Date.now
  const inflight = new Map<string, string>()
  const compactions = new Map<string, number>()
  const cache = new Map<string, { at: number; stamp: string; value: SessionContext }>()

  async function resolve(agentId: string, sessionId: string) {
    const agents = z.array(AgentSummarySchema).parse(await port.listAgents())
    const agent = agents.find((item) => item.id === agentId)
    if (!agent) throw new HttpError(404, 'not_found', 'Agent not found')
    // `score-<roomId>-<agentId>` names the room's session of that agent; in an imported room that continues a Hermes
    // session it stands for that session. The continued session's own id is accepted too.
    const found = db.read((sqlite) => {
      const continued = sqlite
        .prepare(
          'SELECT room_id, session_id FROM room_sessions WHERE agent_id = ? AND session_id = ?',
        )
        .get(agentId, sessionId) as { room_id: string; session_id: string } | undefined
      if (continued) return { roomId: continued.room_id, hermesSession: continued.session_id }
      if (!sessionId.startsWith('score-') || !sessionId.endsWith(`-${agentId}`)) return null
      const id = sessionId.slice('score-'.length, sessionId.length - agentId.length - 1)
      if (!sqlite.prepare('SELECT id FROM rooms WHERE id = ?').get(id)) return null
      const same = sqlite
        .prepare(
          "SELECT session_id FROM room_sessions WHERE room_id = ? AND agent_id = ? AND mode = 'same_session'",
        )
        .get(id, agentId) as { session_id: string } | undefined
      return { roomId: id, hermesSession: same?.session_id ?? sessionId }
    })
    if (found === null) throw new HttpError(404, 'not_found', 'Unknown session')
    const { roomId, hermesSession } = found
    return { agent, roomId, hermesSession }
  }

  function busy(roomId: string, agentId: string): boolean {
    if (rewindingRooms.has(roomId)) return true
    return (
      db.sqlite
        .prepare(
          `SELECT 1 FROM message_runs WHERE room_id = ? AND agent_id = ? AND state IN ('pending', 'active') LIMIT 1`,
        )
        .get(roomId, agentId) !== undefined
    )
  }

  app.get('/api/agents/:agentId/sessions/:sessionId/context', async (request) => {
    const { agentId, sessionId } = ParamsSchema.parse(request.params)
    const { agent, roomId, hermesSession } = await resolve(agentId, sessionId)
    // Re-read after every finished turn of this agent in this room and after a compaction.
    const stamp = db.read((sqlite) => {
      const row = sqlite
        .prepare(
          `SELECT count(*) AS n FROM message_runs WHERE room_id = ? AND agent_id = ? AND state IN ('completed', 'failed')`,
        )
        .get(roomId, agentId) as { n: number }
      return `${row.n}:${compactions.get(sessionId) ?? 0}`
    })
    // Read before the value: an event after it is applied on top by the client.
    const asOfSeq = db.read((sqlite) => headSeq(sqlite))
    const cached = cache.get(sessionId)
    if (cached && cached.stamp === stamp && clock() - cached.at < CACHE_MS)
      return { asOfSeq, ...cached.value }
    const totals = await readAgentContext({ port, db }, agentId)
    let reading = null
    if (agent.runtime === undefined && port.sessionContext)
      reading = await port.sessionContext({ agentId, sessionId: hermesSession }).catch(() => null)
    const at = new Date(clock()).toISOString()
    const value = SessionContextSchema.parse(
      reading
        ? {
            window: reading.window > 0 ? reading.window : (totals.contextLength ?? null),
            used: reading.used,
            measuredAt: at,
            model: reading.model || totals.model,
            source: reading.source,
            parts: reading.parts,
            autoCompactAt: reading.autoCompactAt,
            compactions: compactions.get(sessionId) ?? 0,
          }
        : {
            window: totals.contextLength,
            used: totals.tokens ? totals.tokens.input + totals.tokens.output : null,
            measuredAt: totals.tokens ? at : null,
            model: totals.model,
            source: null,
            parts: null,
            autoCompactAt: null,
            compactions: compactions.get(sessionId) ?? 0,
          },
    )
    cache.set(sessionId, { at: clock(), stamp, value })
    return { asOfSeq, ...value }
  })

  app.post('/api/agents/:agentId/sessions/:sessionId/compact', mutation, async (request, reply) => {
    const { agentId, sessionId } = ParamsSchema.parse(request.params)
    const body = CompactRequestSchema.parse(request.body ?? {})
    const { agent, roomId, hermesSession } = await resolve(agentId, sessionId)
    if (agent.runtime !== undefined || !port.compactSession)
      throw new HttpError(409, 'unsupported', 'This agent’s session cannot be compacted from Score')
    db.read((sqlite) => assertRoomFree(sqlite, roomId, 'session.compact'))
    if (inflight.has(sessionId))
      throw new HttpError(409, 'conflict', 'This session is already being compacted')
    if (busy(roomId, agentId))
      throw new HttpError(409, 'session_busy', `${agent.name} is busy in this room; stop it first`)
    const commandId = randomUUID()
    const key = compactingKey(roomId, agentId)
    inflight.set(sessionId, commandId)
    compactingSessions.add(key)
    const compact = port.compactSession.bind(port)
    void (async () => {
      let event: SessionCompacted
      const base = {
        commandId,
        agentId,
        sessionId,
        roomId,
        keepRecent: body.keepRecent ?? null,
      }
      try {
        const result = await compact({
          agentId,
          sessionId: hermesSession,
          ...(body.keepRecent === undefined ? {} : { keepRecent: body.keepRecent }),
        })
        event =
          result.status === 'compacted'
            ? {
                ...base,
                status: 'compacted',
                reason: null,
                before: result.before,
                after: result.after,
              }
            : result.status === 'nothing'
              ? { ...base, status: 'nothing', reason: null, before: null, after: null }
              : { ...base, status: 'failed', reason: result.reason, before: null, after: null }
        if (result.status === 'compacted')
          compactions.set(sessionId, (compactions.get(sessionId) ?? 0) + 1)
      } catch {
        const reason: CompactFailureReason = 'compact_failed'
        event = { ...base, status: 'failed', reason, before: null, after: null }
      } finally {
        compactingSessions.delete(key)
        inflight.delete(sessionId)
        cache.delete(sessionId)
      }
      try {
        await ingest.submit({
          source: 'compaction',
          identity: commandId,
          apply: () => [{ type: 'session.compacted', data: event }],
        })
        await deps.redispatch()
      } catch (error) {
        app.log.error({ err: error }, 'Could not report a compaction')
      }
    })()
    return reply.code(202).send({ commandId })
  })
}
