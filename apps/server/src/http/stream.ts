import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { createFanout, type FanoutOptions } from '../hub/fanout.ts'
import type { Ingest } from '../hub/ingest.ts'
import { serveStream, type StreamOptions } from '../hub/sse.ts'

const CursorSchema = z.string().regex(/^\d+$/).transform(Number).pipe(z.int().nonnegative())
const QuerySchema = z.object({ since: z.string().optional(), epoch: z.string().optional() })

export interface StreamRouteOptions extends Omit<StreamOptions, 'fanout' | 'logError'> {
  ingest: Ingest
  fanoutOptions?: FanoutOptions
}

export function registerStreamRoute(app: FastifyInstance, options: StreamRouteOptions): void {
  const fanout = createFanout(options.ingest, options.fanoutOptions)
  app.addHook('preClose', async () => fanout.close())
  app.get('/api/stream', async (request, reply) => {
    const query = QuerySchema.parse(request.query)
    const input = request.headers['last-event-id'] ?? query.since
    const cursor = input === undefined ? undefined : CursorSchema.parse(input)
    reply.hijack()
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      'x-accel-buffering': 'no',
    })
    await serveStream(
      reply.raw,
      { cursor, epoch: query.epoch },
      {
        ...options,
        fanout,
        logError: (error) =>
          request.log.error({ err: error }, 'Stream replay failed; closing connection'),
      },
    )
  })
}
