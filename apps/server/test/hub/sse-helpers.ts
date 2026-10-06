import { StreamControlFrameSchema, StreamEventSchema } from '@score/contract'
import type { FastifyInstance } from 'fastify'
import type { OutgoingHttpHeaders } from 'node:http'

export interface SseFrame {
  id?: number
  type?: string
  comment?: string
  data?: unknown
  raw: string
}

export async function readStream(
  app: FastifyInstance,
  url: string,
  signal: AbortSignal,
  headers?: OutgoingHttpHeaders,
) {
  const response = await app.inject({ url, signal, headers, payloadAsStream: true })
  if (response.statusCode !== 200) throw new Error(`Stream returned ${response.statusCode}`)
  const body = response.stream()
  const frames: SseFrame[] = []
  const first = Promise.withResolvers<void>()
  let ended = false
  let failure: unknown
  const done = (async () => {
    const decoder = new TextDecoder()
    let pending = ''
    try {
      for await (const value of body) {
        pending += decoder.decode(value, { stream: true })
        let end: number
        while ((end = pending.indexOf('\n\n')) >= 0) {
          const raw = pending.slice(0, end)
          pending = pending.slice(end + 2)
          const frame: SseFrame = { raw }
          for (const line of raw.split('\n')) {
            if (line.startsWith('id: ')) frame.id = Number(line.slice(4))
            if (line.startsWith('event: ')) frame.type = line.slice(7)
            if (line.startsWith(': ')) frame.comment = line.slice(2)
            if (line.startsWith('data: ')) {
              const json: unknown = JSON.parse(line.slice(6))
              frame.data = frame.type?.startsWith('stream.')
                ? StreamControlFrameSchema.parse(json)
                : StreamEventSchema.parse(json)
            }
          }
          frames.push(frame)
          first.resolve()
        }
      }
    } catch (error) {
      if (!signal.aborted) failure = error
    } finally {
      ended = true
      first.resolve()
    }
  })()
  await first.promise
  return {
    response,
    frames,
    done,
    get ended() {
      return ended
    },
    get failure() {
      return failure
    },
    get seqs() {
      return frames.flatMap((frame) => (frame.id === undefined ? [] : [frame.id]))
    },
  }
}
