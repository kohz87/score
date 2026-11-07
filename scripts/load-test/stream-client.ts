import { origin, webOrigin } from './config.ts'

interface Client {
  headSeq: number
  seqs: number[]
  lags: number[]
  lagByPhase: Map<string, number[]>
  closed: boolean
}

export async function openClient(
  cookie: string,
  abort: AbortSignal,
  currentPhase: () => string,
): Promise<Client> {
  const client: Client = { headSeq: -1, seqs: [], lags: [], lagByPhase: new Map(), closed: false }
  const response = await fetch(`${origin}/api/stream`, { headers: { cookie }, signal: abort })
  if (!response.ok || !response.body) throw new Error(`stream refused: ${response.status}`)
  const hello = Promise.withResolvers<void>()
  void (async () => {
    const decoder = new TextDecoder()
    let buffer = ''
    try {
      for await (const chunk of response.body as unknown as AsyncIterable<Uint8Array>) {
        const received = Date.now()
        buffer += decoder.decode(chunk, { stream: true })
        let end: number
        while ((end = buffer.indexOf('\n\n')) >= 0) {
          const frame = buffer.slice(0, end)
          buffer = buffer.slice(end + 2)
          const data = /^data: (.*)$/m.exec(frame)?.[1]
          if (!data) continue
          const message = JSON.parse(data) as {
            type: string
            seq?: number
            ts?: string
            data?: { headSeq?: number }
          }
          if (message.type === 'stream.hello') {
            client.headSeq = message.data!.headSeq!
            hello.resolve()
          } else if (message.seq !== undefined && message.ts !== undefined) {
            client.seqs.push(message.seq)
            const lag = received - Date.parse(message.ts)
            client.lags.push(lag)
            const phase = currentPhase()
            const list = client.lagByPhase.get(phase) ?? []
            list.push(lag)
            client.lagByPhase.set(phase, list)
          }
        }
      }
    } catch {
      // Aborted at the end of the run.
    }
    client.closed = true
  })()
  await hello.promise
  return client
}

export async function pairCookie(token: string): Promise<string> {
  const response = await fetch(`${origin}/api/session/pair`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', origin: webOrigin, 'x-score-client': 'web' },
    body: JSON.stringify({ token }),
  })
  const cookie = response.headers.getSetCookie()[0]?.split(';')[0]
  if (response.status !== 204 || !cookie) throw new Error(`pairing failed: ${response.status}`)
  return cookie
}
