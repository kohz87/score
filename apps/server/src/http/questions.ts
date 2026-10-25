import { randomUUID } from 'node:crypto'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { AnswerQuestionRequestSchema, type AgentQuestion } from '@score/contract'
import { humanGuard } from '../auth/human.ts'
import type { ScoreDb } from '../db/index.ts'
import { HttpError } from '../errors.ts'
import type { HermesPort } from '../hermes/index.ts'
import type { Ingest } from '../hub/ingest.ts'
import { snapshot } from '../hub/snapshot.ts'
import { requestIdempotency } from './idempotency.ts'
import {
  beginAnswer,
  finishAnswer,
  listQuestions,
  readQuestion,
  resetInterruptedAnswers,
  toQuestion,
} from '../domain/questions.ts'

// 2.3.0 (decision 128, contract §6a): an agent's clarify question and the person's answer.
const QuerySchema = z.object({
  status: z.enum(['pending', 'all']).default('pending'),
  room: z.string().min(1).max(200).optional(),
})
const ParamsSchema = z.object({ questionId: z.string().min(1).max(200) })

export function registerQuestionRoutes(
  app: FastifyInstance,
  deps: {
    db: ScoreDb
    ingest: Ingest
    port: HermesPort
    onError: (error: unknown) => void
    clock?: () => number
  },
): void {
  const { db, ingest, port, onError, clock = Date.now } = deps
  // An answer Score was delivering when it stopped is unknown: the person may answer again (Hermes says if it got it).
  app.addHook('onReady', async () => {
    db.tx((sqlite) => resetInterruptedAnswers(sqlite, new Date(clock()).toISOString()))
  })
  app.get('/api/questions', async (request) => {
    const query = QuerySchema.parse(request.query)
    const result = snapshot(db, (sqlite) => ({
      items: listQuestions(sqlite, {
        status: query.status,
        ...(query.room ? { roomId: query.room } : {}),
      }),
    }))
    return { asOfSeq: result.asOfSeq, ...result.data }
  })
  app.get('/api/questions/:questionId', async (request) => {
    const { questionId } = ParamsSchema.parse(request.params)
    return db.read((sqlite) => readQuestion(sqlite, questionId))
  })

  const receipts = requestIdempotency(db, clock)
  app.post(
    '/api/questions/:questionId/answer',
    { preHandler: [humanGuard(app.pairing), receipts.preHandler], onSend: receipts.onSend },
    async (request, reply) => {
      const { questionId } = ParamsSchema.parse(request.params)
      const body = AnswerQuestionRequestSchema.safeParse(request.body)
      if (!body.success) throw new HttpError(400, 'bad_request', 'That isn’t a valid answer.')
      let started:
        { result: AgentQuestion; target: Parameters<HermesPort['answerQuestion']>[0] } | undefined
      await ingest.submit({
        source: 'questions',
        identity: randomUUID(),
        apply({ sqlite, now }) {
          const { row, text, drafts } = beginAnswer(sqlite, questionId, body.data.answer, now)
          started = {
            result: toQuestion(row),
            target: {
              agentId: row.profile,
              runId: row.run_id,
              promptId: row.prompt_id,
              generation: row.generation,
              answer: text,
            },
          }
          return drafts
        },
      })
      const { result, target } = started!
      // Delivered after the reply: the outcome arrives as `question.updated`.
      void port
        .answerQuestion(target)
        .then(
          (outcome) => (outcome === 'applied' ? ('resolved' as const) : ('gone' as const)),
          (error: unknown) => {
            onError(error)
            return 'failed' as const
          },
        )
        .then((outcome) =>
          ingest.submit({
            source: 'questions',
            identity: randomUUID(),
            apply: ({ sqlite, now }) => finishAnswer(sqlite, questionId, outcome, now),
          }),
        )
        .catch(onError)
      return reply.code(202).send(result)
    },
  )
}
