import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import {
  closeReadOnly,
  HermesDbMissing,
  incarnationOf,
  openReadOnly,
  type ReaderBatch,
} from './sqlite.ts'

const CheckpointSchema = z.object({
  position: z.int().nonnegative(),
  incarnation: z.string().min(1).nullable(),
})
const OptionsSchema = z.object({
  path: z.string().min(1),
  scope: z.string().min(1),
  limit: z.int().positive().default(500),
})

export interface TailCheckpoint {
  scope: string
  position: number
  incarnation: string | null
  resetIncarnation: boolean
}

export interface TailResult<Row> {
  rows: Row[]
  malformed: number
  checkpoint: TailCheckpoint
  missing?: true
}

export function createTailer<Row>(options: {
  path: string
  scope: string
  read(db: DatabaseSync, afterId: number, limit: number): Row[] | ReaderBatch<Row>
  idOf(row: Row): number
  limit?: number
}) {
  const { path, scope, limit } = OptionsSchema.parse(options)
  let db: DatabaseSync | undefined
  let openedIncarnation: string | undefined
  let closed = false

  function release(): void {
    if (db) closeReadOnly(db)
    db = undefined
    openedIncarnation = undefined
  }

  return {
    poll(checkpoint?: z.input<typeof CheckpointSchema>): TailResult<Row> {
      if (closed) throw new Error('Hermes tailer is closed')
      const stored = checkpoint === undefined ? undefined : CheckpointSchema.parse(checkpoint)
      const previousIncarnation = openedIncarnation
      try {
        let incarnation = incarnationOf(path)
        if (db && openedIncarnation !== incarnation) release()
        // Stat on both sides of open so a concurrent rename cannot label an old connection as new.
        for (let attempt = 0; !db && attempt < 3; attempt++) {
          const connection = openReadOnly(path)
          let afterOpen: string
          try {
            afterOpen = incarnationOf(path)
          } catch (error) {
            closeReadOnly(connection)
            throw error
          }
          if (incarnation === afterOpen) {
            db = connection
            openedIncarnation = incarnation
          } else {
            closeReadOnly(connection)
            incarnation = afterOpen
          }
        }
        if (!db) throw new Error(`Hermes database changed repeatedly while opening: ${path}`)
        const resetIncarnation = stored
          ? stored.incarnation !== incarnation
          : previousIncarnation !== undefined && previousIncarnation !== incarnation
        const afterId = resetIncarnation ? 0 : (stored?.position ?? 0)
        const result = options.read(db, afterId, limit)
        const batch = Array.isArray(result) ? { rows: result, malformed: 0 } : result
        let position = afterId
        for (const row of batch.rows) {
          const id = z.int().positive().parse(options.idOf(row))
          if (id <= afterId)
            throw new Error(`Hermes reader returned ID ${id} at or before ${afterId}`)
          position = Math.max(position, id)
        }
        if ('position' in batch && batch.position !== undefined) {
          position = Math.max(position, z.int().nonnegative().parse(batch.position))
        }
        return {
          rows: batch.rows,
          malformed: z.int().nonnegative().parse(batch.malformed),
          checkpoint: { scope, position, incarnation, resetIncarnation },
        }
      } catch (error) {
        if (!(error instanceof HermesDbMissing)) throw error
        release()
        return {
          rows: [],
          malformed: 0,
          checkpoint: {
            scope,
            position: stored?.position ?? 0,
            incarnation: stored?.incarnation ?? null,
            resetIncarnation: false,
          },
          missing: true,
        }
      }
    },
    close(): void {
      release()
      closed = true
    },
  }
}
