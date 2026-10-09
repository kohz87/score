import { createServer, type Server, type Socket } from 'node:net'
import type { FastifyInstance } from 'fastify'

const PEEK_TIMEOUT_MS = 10_000
/** After the first byte: the TLS handshake (or the request line and headers) must complete in this time. */
const FIRST_REQUEST_DEADLINE_MS = 15_000

/**
 * One port, both protocols (5.18): the first byte of a connection tells them apart. 0x16 is a TLS handshake record and
 * goes to the HTTPS app; anything else is plain HTTP and goes to the guide app. Neither app listens on its own.
 */
export async function listenDual(
  tlsApp: FastifyInstance,
  plainApp: FastifyInstance,
  {
    host,
    port,
    peekTimeoutMs = PEEK_TIMEOUT_MS,
    firstRequestDeadlineMs = FIRST_REQUEST_DEADLINE_MS,
  }: { host: string; port: number; peekTimeoutMs?: number; firstRequestDeadlineMs?: number },
): Promise<{ server: Server; destroyConnections: () => void }> {
  await Promise.all([tlsApp.ready(), plainApp.ready()])
  // Fastify only closes connections of servers it listens on itself, so the raw sockets are tracked here.
  const sockets = new Set<Socket>()
  // Backend servers are fed through emit('connection') and never see 'listening', which is where Node starts its
  // connection tracking (header and request timeouts): emit it once so those apply to handed-over sockets too.
  tlsApp.server.emit('listening')
  plainApp.server.emit('listening')
  // Own deadline between the first byte and a completed handshake / parsed request head (keyed by peer, because the
  // TLS and HTTP layers see wrapped sockets).
  const deadlines = new Map<string, NodeJS.Timeout>()
  const peerKey = (socket: { remoteAddress?: string; remotePort?: number }) =>
    `${socket.remoteAddress}:${socket.remotePort}`
  const settle = (socket: { remoteAddress?: string; remotePort?: number }) => {
    const key = peerKey(socket)
    clearTimeout(deadlines.get(key))
    deadlines.delete(key)
  }
  tlsApp.server.on('secureConnection', settle)
  plainApp.server.on('request', (request) => settle(request.socket))
  const server = createServer({ pauseOnConnect: true }, (socket: Socket) => {
    sockets.add(socket)
    const key = peerKey(socket)
    socket.once('close', () => {
      sockets.delete(socket)
      clearTimeout(deadlines.get(key))
      deadlines.delete(key)
    })
    // A client that connects and says nothing must not hold the socket forever.
    socket.setTimeout(peekTimeoutMs, () => socket.destroy())
    socket.on('error', () => socket.destroy())
    socket.once('data', (chunk: Buffer) => {
      socket.setTimeout(0)
      const timer = setTimeout(() => socket.destroy(), firstRequestDeadlineMs)
      timer.unref()
      deadlines.set(key, timer)
      socket.pause()
      socket.unshift(chunk)
      ;(chunk[0] === 0x16 ? tlsApp : plainApp).server.emit('connection', socket)
      process.nextTick(() => socket.resume())
    })
    socket.resume()
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject)
    server.listen({ host, port }, () => {
      server.off('error', reject)
      resolve()
    })
  })
  return { server, destroyConnections: () => sockets.forEach((socket) => socket.destroy()) }
}
