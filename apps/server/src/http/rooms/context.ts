import type { AgentSummary } from '@score/contract'
import type { onSendHookHandler, preHandlerHookHandler } from 'fastify'
import type { ScoreDb } from '../../db/index.ts'
import type { RoutingDispatcher } from '../../domain/routing-dispatch.ts'
import type { HermesPort } from '../../hermes/index.ts'
import type { Ingest, IngestResult } from '../../hub/ingest.ts'
import type { MediaStore } from '../../media/store.ts'
import type { AgentWorkspaces } from '../../workspace/agent-workspace.ts'

export interface RoomRouteDeps {
  port: HermesPort
  db: ScoreDb
  ingest: Ingest
  clock: () => number
  media?: MediaStore
  workspaces?: AgentWorkspaces
  mutation: { preHandler: preHandlerHookHandler[]; onSend: onSendHookHandler }
  routing: RoutingDispatcher
  agents: () => Promise<AgentSummary[]>
  validateAgents: (ids: string[]) => Promise<void>
  refresh: () => Promise<IngestResult>
  isTeamRoom: (roomId: string) => boolean
  assertNotRewinding: (roomId: string) => void
}
