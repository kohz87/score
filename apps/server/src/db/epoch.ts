import { randomBytes } from 'node:crypto'
import { z } from 'zod'
import type { ScoreDb } from './database.ts'

const EpochRowSchema = z.object({ value: z.string().regex(/^[a-f0-9]{32}$/) })

export function getEpoch(db: ScoreDb): string {
  return EpochRowSchema.parse(db.sqlite.prepare("SELECT value FROM meta WHERE key = 'epoch'").get())
    .value
}

export function resetEpoch(db: ScoreDb): string {
  const epoch = randomBytes(16).toString('hex')
  db.sqlite
    .prepare(
      "INSERT INTO meta (key, value) VALUES ('epoch', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
    )
    .run(epoch)
  return epoch
}
