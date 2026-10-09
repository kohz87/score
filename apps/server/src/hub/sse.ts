import {
  StreamEventSchema,
  StreamHelloSchema,
  StreamResetSchema,
  type SystemStatus,
} from '@score/contract'
import type { ServerResponse } from 'node:http'
import { setImmediate } from 'node:timers/promises'
import { z } from 'zod'
import type { ScoreDb } from '../db/index.ts'
import { eventFrame, OVERSIZED_RESET_FRAME, type Fanout } from './fanout.ts'
import { retainEvents } from './retention.ts'
import { snapshot } from './snapshot.ts'

const FloorRowSchema = z.object({ seq: z.int().positive().nullable() })
const EventRowSchema = z.object({
  seq: z.int().positive(),
  ts: z.string(),
  type: z.string(),
  data: z.string(),
})

export interface StreamOptions {
  db: ScoreDb
  fanout: Fanout
  getEpoch(): string
  getSystemStatus(): SystemStatus
  heartbeatMs?: number
  logError(error: unknown): void
}

export async function serveStream(
  raw: ServerResponse,
  { cursor, epoch }: { cursor?: number; epoch?: string },
  { db, fanout, getEpoch, getSystemStatus, heartbeatMs = 15_000, logError }: StreamOptions,
): Promise<void> {
  const subscriber = fanout.subscribe(raw)
  const retention = retainEvents(db)
  let heartbeat: NodeJS.Timeout | undefined
  const cleanup = () => {
    clearInterval(heartbeat)
    retention.release()
  }
  raw.once('close', cleanup)
  try {
    const fence = snapshot(db, (sqlite) => ({
      floor: FloorRowSchema.parse(sqlite.prepare('SELECT min(seq) AS seq FROM events').get()).seq,
      epoch: getEpoch(),
    }))
    const head = fence.asOfSeq
    const floor = fence.data.floor ?? head + 1
    const system = getSystemStatus()
    const hello = StreamHelloSchema.parse({
      type: 'stream.hello',
      data: { epoch: fence.data.epoch, headSeq: head, mode: system.mode, system },
    })
    subscriber.write(`event: stream.hello\ndata: ${JSON.stringify(hello)}\n\n`)
    if (!subscriber.closed) {
      heartbeat = setInterval(() => subscriber.write(': hb\n\n'), heartbeatMs)
      heartbeat.unref()
    }
    const reason =
      cursor === undefined
        ? undefined
        : epoch !== fence.data.epoch
          ? 'epoch'
          : cursor > head
            ? 'future_cursor'
            : cursor < floor - 1
              ? 'pruned'
              : undefined
    if (reason) {
      const reset = StreamResetSchema.parse({ type: 'stream.reset', data: { reason } })
      subscriber.write(`event: stream.reset\ndata: ${JSON.stringify(reset)}\n\n`)
    } else if (cursor !== undefined) {
      let after = cursor
      retention.advance(after)
      const page = db.sqlite.prepare(
        'SELECT seq, ts, type, data FROM events WHERE seq > ? AND seq <= ? ORDER BY seq LIMIT 500',
      )
      while (!subscriber.closed && after < head) {
        const rows = page.all(after, head)
        if (rows.length === 0) break
        for (const row of rows) {
          if (subscriber.closed) break
          const stored = EventRowSchema.parse(row)
          if (Buffer.byteLength(stored.data) + 256 > fanout.maxFrameBytes) {
            // Too big to ever send: make the client resync instead of retrying the same event forever.
            subscriber.write(OVERSIZED_RESET_FRAME)
            after = stored.seq
            continue
          }
          const event = StreamEventSchema.parse({ ...stored, data: JSON.parse(stored.data) })
          subscriber.write(eventFrame(event))
          after = event.seq
          await subscriber.writable()
        }
        retention.advance(after)
        // Give producers and sockets a turn between bounded replay pages.
        await setImmediate()
      }
    }
    subscriber.release(head)
  } catch (error) {
    logError(error)
    subscriber.close()
  } finally {
    retention.release()
    if (subscriber.closed) {
      cleanup()
      raw.off('close', cleanup)
    }
  }
}
