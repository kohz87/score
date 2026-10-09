import { createServer, type Server, type Socket } from 'node:net'
import type { FastifyInstance } from 'fastify'

const PEEK_TIMEOUT_MS = 10_000

/**
 * One port, both protocols (5.18): the first byte of a connection tells them apart. 0x16 is a TLS handshake record and
 * goes to the HTTPS app; anything else is plain HTTP and goes to the guide app. Neither app listens on its own.
 */
export async function listenDual(
  tlsApp: FastifyInstance,
  plainApp: FastifyInstance,
  { host, port }: { host: string; port: number },
): Promise<{ server: Server; destroyConnections: () => void }> {
  await Promise.all([tlsApp.ready(), plainApp.ready()])
  // Fastify only closes connections of servers it listens on itself, so the raw sockets are tracked here.
  const sockets = new Set<Socket>()
  const server = createServer({ pauseOnConnect: true }, (socket: Socket) => {
    sockets.add(socket)
    socket.once('close', () => sockets.delete(socket))
    // A client that connects and says nothing must not hold the socket forever.
    socket.setTimeout(PEEK_TIMEOUT_MS, () => socket.destroy())
    socket.on('error', () => socket.destroy())
    socket.once('data', (chunk: Buffer) => {
      socket.setTimeout(0)
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
