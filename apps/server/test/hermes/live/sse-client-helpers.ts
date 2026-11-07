import { afterEach, vi } from 'vitest'
import { connectSse, type SseConnection, type SseFrame } from '../../../src/hermes/live/index.ts'

export const encoder = new TextEncoder()
export const url = 'http://localhost/p/builder/v1/runs/example/events'
export const event = (data: string, id = '', name = 'message'): SseFrame => ({
  type: 'event',
  id,
  event: name,
  data,
})
export const comment = (text: string): SseFrame => ({ type: 'comment', text })
export const wireEvent = (id: string) =>
  `id: ${id}\ndata: {"event":"message.delta","seq":${id}}\n\n`

export async function collect(connection: SseConnection): Promise<SseFrame[]> {
  const frames: SseFrame[] = []
  for await (const frame of connection) frames.push(frame)
  return frames
}

export function response(
  text: string,
  options: { disconnect?: boolean; open?: boolean } = {},
): Response {
  let sent = false
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(controller) {
        if (!sent) {
          sent = true
          controller.enqueue(encoder.encode(text))
          return
        }
        if (options.disconnect) controller.error(new Error('socket disconnected'))
        else if (!options.open) controller.close()
      },
    }),
    { headers: { 'content-type': 'text/event-stream; charset=utf-8' } },
  )
}

export function fromText(text: string, options?: Parameters<typeof response>[1]): SseConnection {
  return connectSse({ url, fetch: async () => response(text, options) })
}

export function installSseHooks() {
  afterEach(() => vi.useRealTimers())
}
