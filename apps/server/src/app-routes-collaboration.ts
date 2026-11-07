import type { FastifyInstance } from 'fastify'
import type { Config } from './config.ts'
import type { ScoreDb } from './db/index.ts'
import type { Ingest } from './hub/ingest.ts'
import type { HermesPort } from './hermes/index.ts'
import type { BridgeDeps } from './hermes/index.ts'
import type { KnowledgeVault } from './knowledge/vault.ts'
import type { MediaStore } from './media/store.ts'
import type { AgentWorkspaces } from './workspace/agent-workspace.ts'
import { loadSealingKey, sealer } from './auth/sealing.ts'
import { humanGuard } from './auth/human.ts'
import { serverOrigin } from './config.ts'
import { createBriefControl, type BriefControl } from './http/brief-control.ts'
import { createTaskHolds, type TaskHolds } from './http/task-holds.ts'
import { registerConversationRoutes } from './http/conversations.ts'
import { registerOneJobRoutes } from './http/one-job.ts'
import { registerOutsideSessionRoutes } from './http/outside-sessions.ts'
import { registerRoomRoutes } from './http/rooms.ts'
import { registerTriggerRoutes } from './http/triggers.ts'
import { registerWorkspacesRoutes } from './http/workspaces.ts'
import { setRoomCompatibility } from './domain/rooms.ts'
import { teamPausedAt } from './domain/team-pause.ts'
import type { HoldOwner } from './domain/holds.ts'
import type { Orchestrator } from './domain/orchestration/executor.ts'

export interface CollaborationRouteDeps {
  app: FastifyInstance
  port: HermesPort
  db: ScoreDb | undefined
  ingest: Ingest | undefined
  config: Config
  clock: (() => number) | undefined
  mediaStore: MediaStore | undefined
  workspaces: AgentWorkspaces
  knowledge: KnowledgeVault | undefined
  ownsHome: boolean
  orchestrator: Orchestrator | undefined
  bridge: BridgeDeps | undefined
}

export interface CollaborationRoutes {
  dispatch: () => Promise<void>
  holds: TaskHolds
  control: BriefControl
  ownerPaused: (owner: HoldOwner) => boolean
}

export function registerCollaborationRoutes({
  app,
  port,
  db,
  ingest,
  config,
  clock,
  mediaStore,
  workspaces,
  knowledge,
  ownsHome,
  orchestrator,
  bridge,
}: CollaborationRouteDeps): CollaborationRoutes | undefined {
  if (!db || !ingest) return undefined
  setRoomCompatibility(
    () => bridge?.getCompatibility().disabled ?? port.status().compatibility.disabled,
  )
  const dispatch = registerRoomRoutes(
    app,
    port,
    db,
    ingest,
    clock,
    mediaStore,
    workspaces,
    knowledge,
  )
  // 3.28.0 (decision 164): Stop job and the queue of trigger calls waiting for a chat's one job.
  registerOneJobRoutes(app, {
    db,
    ingest,
    port,
    dispatch,
    ...(orchestrator ? { orchestrator } : {}),
    ...(clock ? { clock } : {}),
  })
  registerWorkspacesRoutes(app, { port, db, ingest, config, ...(clock ? { clock } : {}) })
  // PLAN 11.1d: webhook triggers. Their signing secrets are sealed with a key in Score's home, so only a server that
  // owns its home (never a test against a borrowed database) serves them.
  if (ownsHome) {
    const guard = { preHandler: [humanGuard(app.pairing)] }
    registerTriggerRoutes(app, {
      db,
      ingest,
      seal: sealer(loadSealingKey(config.home)),
      guard,
      origin: serverOrigin(config),
      redispatch: dispatch,
      ...(clock ? { clock } : {}),
    })
  }
  registerConversationRoutes(app, { db, ingest, port, ...(clock ? { clock } : {}) })
  registerOutsideSessionRoutes(app, { db, ingest, port })
  const holds = createTaskHolds({
    port,
    db,
    ingest,
    onInert: (owner, taskIds) =>
      app.log.warn(
        { owner, taskIds },
        'Pause release skipped holds that belong to another Kanban board lineage',
      ),
  })
  const control = createBriefControl({ port, db, ingest, holds, dispatch })
  // A crash between "pause recorded" and "task parked" (or "resumed" and "unparked") leaves holds behind. The
  // server runs this once the adapter has started, and again until nothing is left (Hermes may be unreachable).
  const ownerPaused = (owner: HoldOwner): boolean =>
    db.read((sqlite) => {
      if (owner.kind === 'team') return teamPausedAt(sqlite) !== null
      return (
        sqlite
          .prepare(
            owner.kind === 'brief'
              ? 'SELECT 1 FROM briefs WHERE id = ? AND paused_at IS NOT NULL'
              : 'SELECT 1 FROM agent_pauses WHERE agent_id = ?',
          )
          .get(owner.id) !== undefined
      )
    })
  app.decorate('recoverTaskHolds', () => holds.recover(ownerPaused))
  return { dispatch, holds, control, ownerPaused }
}
