import type { DatabaseSync } from 'node:sqlite'
import { LookSettingsSchema, type LookSettings } from '@score/contract'

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

export function resetLook(sqlite: DatabaseSync): void {
  writeLook(sqlite, DEFAULT_LOOK)
}
