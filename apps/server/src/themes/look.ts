import type { DatabaseSync } from 'node:sqlite'
import { LookSettingsSchema, ResetGenerationSchema, type LookSettings } from '@score/contract'

// Node built-ins and the contract only: `scripts/look.mjs` imports this file as it is (Score may be stopped).
export const DEFAULT_LOOK: LookSettings = { activeTheme: 'score', mode: 'system' }

export function readLook(sqlite: DatabaseSync): LookSettings {
  const rows = sqlite
    .prepare("SELECT key, value FROM meta WHERE key IN ('look.activeTheme', 'look.mode')")
    .all() as { key: string; value: string }[]
  const value = (key: string) => rows.find((row) => row.key === key)?.value
  // A damaged row falls back to the default rather than locking the owner out of a working look.
  const parsed = LookSettingsSchema.safeParse({
    activeTheme: value('look.activeTheme') ?? DEFAULT_LOOK.activeTheme,
    mode: value('look.mode') ?? DEFAULT_LOOK.mode,
  })
  return parsed.success ? parsed.data : { ...DEFAULT_LOOK }
}

export function writeLook(sqlite: DatabaseSync, look: LookSettings): void {
  const put = sqlite.prepare(
    'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
  )
  put.run('look.activeTheme', look.activeTheme)
  put.run('look.mode', look.mode)
}

const GENERATION_KEY = 'look.resetGeneration'

/** How many host resets have run (0 before the first). A damaged value counts as 0 rather than breaking the list. */
export function readResetGeneration(sqlite: DatabaseSync): number {
  const row = sqlite.prepare('SELECT value FROM meta WHERE key = ?').get(GENERATION_KEY) as
    { value: string } | undefined
  const parsed = ResetGenerationSchema.safeParse(Number(row?.value ?? 0))
  return parsed.success ? parsed.data : 0
}

/**
 * The host's way back (`scripts/score look reset`): the default shared look, and a new generation so every browser that
 * kept its own override or boot cache from before drops them (contract § 16). The caller runs this in a transaction.
 */
export function resetLook(sqlite: DatabaseSync): void {
  writeLook(sqlite, DEFAULT_LOOK)
  sqlite
    .prepare(
      'INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value',
    )
    .run(GENERATION_KEY, String(readResetGeneration(sqlite) + 1))
}
