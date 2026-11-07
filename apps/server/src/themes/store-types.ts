import { createHash } from 'node:crypto'
import { z } from 'zod'
import type { ThemeManifest, ThemeSummary } from '@score/contract'
import type { ScoreDb } from '../db/index.ts'

export const RowSchema = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string(),
  manifest_json: z.string(),
  css: z.string(),
  licenses_json: z.string(),
  revision: z.number().int(),
  source: z.enum(['imported', 'custom']),
  created_at: z.string(),
  updated_at: z.string(),
})

export type Row = z.infer<typeof RowSchema>
export const LicensesSchema = z.record(z.string(), z.string())

export const ASSET_DIRS = ['fonts', 'img'] as const

export interface StoredTheme {
  manifest: ThemeManifest
  css: string
  source: ThemeSummary['source']
  updatedAt: string
  /** Licence files of the package (`LICENSE`, `OFL.txt`) -> text; put back into its export. */
  licenses: Record<string, string>
  /** Persisted write counter of the row (0 for a built-in); asset bytes can't be hashed cheaply, so it stands for them. */
  revision: number
}

/**
 * Conflict-check token for a whole package: the row's write number (every write bumps it, and it is what changes when
 * only assets or licence files change) together with the manifest, CSS and licence texts the row holds.
 */
export function themeEtag(
  theme: Pick<StoredTheme, 'manifest' | 'css' | 'licenses' | 'revision'>,
): string {
  return createHash('sha256')
    .update(String(theme.revision))
    .update('\0')
    .update(JSON.stringify(theme.manifest))
    .update('\0')
    .update(theme.css)
    .update('\0')
    .update(JSON.stringify(theme.licenses))
    .digest('hex')
}

/**
 * An earlier swap or id move of this theme is not settled yet: its note still stands for an old folder that recovery
 * will put back. Writing the id now would let that later step put old files under a newer row (re-gate finding 2).
 */
export class ThemeLockedError extends Error {
  constructor(readonly themeId: string) {
    super(
      'This theme is still being put back after an interrupted change. Try again in a moment, or restart Score.',
    )
  }
}

/** The two file-system moves a theme swap is made of; tests replace them to fail at a chosen step. */
export interface ThemeFs {
  rename(from: string, to: string): void
  rm(path: string): void
  /** Flushes a file or folder to disk (fsync); default: the real one. Tests record or fail it. */
  sync?(path: string): void
}

export interface ThemeContext {
  db: ScoreDb
  root: string
  clock: () => number
  fs: ThemeFs
  sync(path: string): void
}
