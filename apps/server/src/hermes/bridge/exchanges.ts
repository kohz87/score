import { BridgeExchangeActionRequestSchema, ExchangeReceiptSchema } from '@score/contract'
import type { FastifyInstance } from 'fastify'
import type { ScoreDb } from '../../db/index.ts'
import { stageAction, turnForCapability } from '../../domain/exchanges/actions.ts'
import type { Producer } from './registry.ts'

// Contract §11 "Exchange actions" (PLAN 11.1b). The capability names the turn; the producer's profile must be that
// turn's agent. Staging only: the action is applied when the turn completes.
export function registerBridgeExchangeRoutes(
  app: FastifyInstance,
  deps: { db: ScoreDb; authenticate(value: unknown): Producer; clock: () => number },
): void {
  const { db, authenticate, clock } = deps
  app.post('/bridge/v1/exchanges/action', { bodyLimit: 64 * 1024 }, async (request) => {
    const agentId = authenticate(request.headers.authorization).profile
    const body = BridgeExchangeActionRequestSchema.parse(request.body)
    return ExchangeReceiptSchema.parse(
      db.tx((sqlite) => {
        const turn = turnForCapability(sqlite, body.capability, agentId)
        if (!turn)
          return {
            status: 'refused',
            commandId: body.commandId,
            action: body.action.action,
            code: 'capability_invalid',
            message:
              'That capability isn’t valid for a turn of yours that is still running. Copy it exactly from this turn’s instructions.',
          }
        return stageAction(
          sqlite,
          { turn, commandId: body.commandId, action: body.action, channel: 'bridge' },
          new Date(clock()).toISOString(),
        )
      }),
    )
  })
}
