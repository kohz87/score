import { randomUUID } from 'node:crypto'
import { AgentSummarySchema } from '@score/contract'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { humanGuard } from '../auth/human.ts'
import type { ScoreDb } from '../db/index.ts'
import { agentAdmits } from '../domain/agent-lifecycle.ts'
import { COMMANDS } from '../domain/parse.ts'
import { refreshRooms, staleRoomIds } from '../domain/rooms.ts'
import { RoutingDispatcher } from '../domain/routing-dispatch.ts'
import { HttpError } from '../errors.ts'
import type { HermesPort } from '../hermes/index.ts'
import type { Ingest } from '../hub/ingest.ts'
import type { KnowledgeVault } from '../knowledge/vault.ts'
import type { MediaStore } from '../media/store.ts'
import type { AgentWorkspaces } from '../workspace/agent-workspace.ts'
import { requestIdempotency } from './idempotency.ts'
import { registerJobRoutes } from './jobs.ts'
import { registerChatEffortRoutes } from './chat-efforts.ts'
import { registerChatModelRoutes } from './chat-models.ts'
import { registerSessionCompactionRoutes } from './session-compaction.ts'
import type { RoomRouteDeps } from './rooms/context.ts'
import { registerMessagePostRoutes } from './rooms/message-post-routes.ts'
import { registerMessageReadRoutes } from './rooms/message-read-routes.ts'
import { registerMessageRunRoutes } from './rooms/message-run-routes.ts'
import { registerRewindRoutes } from './rooms/rewind-routes.ts'
import { assertNotRewinding } from './rooms/rewind-guard.ts'
import { registerRoomCatalogueRoutes } from './rooms/room-routes.ts'
import { registerSummaryRoutes } from './rooms/summary-routes.ts'
import { registerVersionRoutes } from './rooms/version-routes.ts'

export function registerRoomRoutes(
  app: FastifyInstance,
  port: HermesPort,
  db: ScoreDb,
  ingest: Ingest,
  clock = Date.now,
  media?: MediaStore,
  workspaces?: AgentWorkspaces,
  knowledge?: KnowledgeVault,
): () => Promise<void> {
  // JSON escaping can expand a valid 16 KB text beyond the default receipt limit.
  const receipts = requestIdempotency(db, clock, (app.initialConfig.bodyLimit ?? 1048576) + 65536)
  const mutation = {
    preHandler: [humanGuard(app.pairing), receipts.preHandler],
    onSend: receipts.onSend,
  }
  // The everyone team room (decision 136): always the whole team under its own name. Chosen team rooms are ordinary
  // rooms for renaming, archiving, members and deleting.
  const isTeamRoom = (roomId: string) =>
    db.read((sqlite) =>
      Boolean(
        sqlite
          .prepare("SELECT 1 FROM rooms WHERE id = ? AND role = 'team' AND team_everyone = 1")
          .get(roomId),
      ),
    )
  const routing = new RoutingDispatcher(db, ingest, port, (error) =>
    app.log.error({ err: error }, 'Room run admission failed'),
  )
  app.addHook('preClose', async () => {
    await routing.close()
  })
  registerChatEffortRoutes(app, { db, ingest, port, mutation })
  registerChatModelRoutes(app, { db, ingest, port, mutation })
  registerJobRoutes(app, {
    db,
    ingest,
    port,
    mutation,
    redispatch: () => routing.dispatch(),
  })
  registerSessionCompactionRoutes(app, {
    port,
    db,
    ingest,
    mutation,
    redispatch: () => routing.dispatch(),
    clock,
    ...(knowledge ? { knowledge } : {}),
  })
  const agents = async () =>
    z
      .array(AgentSummarySchema)
      .parse(await port.listAgents())
      .filter((agent) => agentAdmits(db.sqlite, agent.id))
  async function validateAgents(ids: string[]) {
    const known = new Set((await agents()).map((agent) => agent.id))
    if (ids.some((id) => !known.has(id)))
      throw new HttpError(400, 'bad_request', 'Couldn’t find that agent.')
  }
  const refresh = () =>
    ingest.submit({
      source: 'rooms',
      identity: randomUUID(),
      apply: ({ sqlite, now }) => refreshRooms(sqlite, now),
    })
  // The periodic tick reads first: an idle refresh must not create an observation (gate review #13).
  // Cheap: two indexed reads. Sends only rooms whose busy set changed (an approval ran out, compatibility changed).
  const tick = async () => {
    const now = new Date(clock()).toISOString()
    if (db.read((sqlite) => staleRoomIds(sqlite, now)).length > 0) await refresh()
  }
  const timer = setInterval(() => {
    void tick().catch((error: unknown) =>
      app.log.error({ err: error }, 'Room activity refresh failed'),
    )
  }, 30000)
  timer.unref()
  app.addHook('preClose', async () => {
    clearInterval(timer)
  })

  // /remember and /skill parse but have no write path yet (they answer 501), so the slash menu does not offer them.
  app.get('/api/commands', async () => ({
    items: COMMANDS.filter(({ name }) => name !== 'remember' && name !== 'skill'),
  }))

  const deps: RoomRouteDeps = {
    port,
    db,
    ingest,
    clock,
    mutation,
    routing,
    agents,
    validateAgents,
    refresh,
    isTeamRoom,
    assertNotRewinding,
    ...(media ? { media } : {}),
    ...(workspaces ? { workspaces } : {}),
  }
  registerRoomCatalogueRoutes(app, deps)
  registerMessageReadRoutes(app, deps)
  registerRewindRoutes(app, deps)
  registerSummaryRoutes(app, deps)
  registerVersionRoutes(app, deps)
  registerMessageRunRoutes(app, deps)
  registerMessagePostRoutes(app, deps)
  return () => routing.dispatch()
}
