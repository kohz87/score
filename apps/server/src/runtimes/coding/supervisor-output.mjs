import { MAX_CHUNK_BYTES } from './supervisor-protocol.mjs'

export function createOutputPump(ctx) {
  return function pump(stream, name) {
    stream.on('data', (chunk) => {
      if (ctx.capExceeded) return
      ctx.bytes[name] += chunk.length
      if (
        ctx.bytes[name] > ctx.limits.maxStreamBytes ||
        ctx.bytes.stdout + ctx.bytes.stderr > ctx.limits.maxRunBytes
      ) {
        ctx.capExceeded = true
        ctx.send({ t: 'error', code: 'output-cap' })
        ctx.requestStop('output-cap')
        return
      }
      for (let off = 0; off < chunk.length; off += MAX_CHUNK_BYTES) {
        const part = chunk.subarray(off, off + MAX_CHUNK_BYTES)
        ctx.seq[name] += 1
        ctx.send({ t: 'out', stream: name, seq: ctx.seq[name], data: part.toString('base64') })
      }
      // Backpressure (design section 4): stop reading the CLI's pipes while the socket buffer is high; the CLI blocks.
      if (ctx.sock.writableLength > ctx.limits.highWaterBytes) ctx.pauseOutput()
    })
    stream.on('error', () => {
      ctx.forced[name] = true
    })
    stream.on('close', () => {
      if (ctx.eof[name]) return
      ctx.eof[name] = true
      ctx.send({
        t: 'eof',
        stream: name,
        lastSeq: ctx.seq[name],
        ...(ctx.forced[name] ? { forced: true } : {}),
      })
      void ctx.maybeDrained()
    })
  }
}
