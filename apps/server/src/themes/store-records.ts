import type { DatabaseSync } from 'node:sqlite'
import { BUILTIN_THEME_IDS, ThemeManifestSchema } from '@score/contract'
import type { ThemeManifest, ThemeSummary } from '@score/contract'
import { BUILTIN_UPDATED_AT, builtinCss, builtinLicenses, builtinManifest } from './builtin.ts'
import {
  LicensesSchema,
  RowSchema,
  type Row,
  type StoredTheme,
  type ThemeContext,
} from './store-types.ts'

export function now(context: ThemeContext): string {
  return new Date(context.clock()).toISOString()
}

export function rows(context: ThemeContext): Row[] {
  return context.db.read((sqlite) =>
    RowSchema.array().parse(sqlite.prepare('SELECT * FROM themes ORDER BY id').all()),
  )
}

export function row(context: ThemeContext, id: string): Row | null {
  const found = context.db.read((sqlite) =>
    sqlite.prepare('SELECT * FROM themes WHERE id = ?').get(id),
  )
  return found === undefined ? null : RowSchema.parse(found)
}

function parse(row: Row): StoredTheme {
  return {
    manifest: ThemeManifestSchema.parse(JSON.parse(row.manifest_json)),
    css: row.css,
    source: row.source,
    updatedAt: row.updated_at,
    licenses: LicensesSchema.parse(JSON.parse(row.licenses_json)),
    revision: row.revision,
  }
}

export function getTheme(context: ThemeContext, id: string): StoredTheme | null {
  const manifest = builtinManifest(id)
  if (manifest)
    return {
      manifest,
      css: builtinCss(id),
      source: 'builtin',
      updatedAt: BUILTIN_UPDATED_AT,
      licenses: builtinLicenses(id),
      revision: 0,
    }
  const found = row(context, id)
  return found ? parse(found) : null
}

export function existsTheme(context: ThemeContext, id: string): boolean {
  return getTheme(context, id) !== null
}

export function themeSummary(theme: StoredTheme): ThemeSummary {
  const { manifest } = theme
  return {
    id: manifest.id,
    name: manifest.name,
    version: manifest.version,
    author: manifest.author ?? null,
    description: manifest.description ?? null,
    source: theme.source,
    updatedAt: theme.updatedAt,
    hasCss: theme.css.length > 0,
  }
}

export function listThemes(context: ThemeContext): ThemeSummary[] {
  const builtins = BUILTIN_THEME_IDS.map((id) => getTheme(context, id)!)
  return [...builtins, ...rows(context).map((item) => parse(item))].map((theme) =>
    themeSummary(theme),
  )
}

/** Inserts or replaces the row of an imported or custom theme. `createdAt` is kept on a replace. */
export function upsertTheme(
  context: ThemeContext,
  sqlite: DatabaseSync,
  manifest: ThemeManifest,
  css: string,
  source: 'imported' | 'custom',
  licenses?: Record<string, string>,
): void {
  const at = now(context)
  const revision = nextRevision(sqlite)
  sqlite
    .prepare(
      `INSERT INTO themes (id, name, version, manifest_json, css, source, created_at, updated_at, licenses_json, revision)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT (id) DO UPDATE SET name = excluded.name, version = excluded.version,
         manifest_json = excluded.manifest_json, css = excluded.css, source = excluded.source,
         updated_at = excluded.updated_at, revision = excluded.revision,
         licenses_json = CASE WHEN ? THEN excluded.licenses_json ELSE themes.licenses_json END`,
    )
    .run(
      manifest.id,
      manifest.name,
      manifest.version,
      JSON.stringify(manifest),
      css,
      source,
      at,
      at,
      JSON.stringify(licenses ?? {}),
      revision,
      licenses === undefined ? 0 : 1,
    )
}

/** The next number of the one counter every theme write takes (inside the writer's transaction). */
export function nextRevision(sqlite: DatabaseSync): number {
  const row = sqlite
    .prepare(
      `INSERT INTO meta (key, value) VALUES ('themes.revision', '1')
       ON CONFLICT (key) DO UPDATE SET value = CAST(meta.value AS INTEGER) + 1
       RETURNING CAST(value AS INTEGER) AS n`,
    )
    .get() as { n: number }
  return row.n
}

/** Ids named by a note that is still standing (recovery could not settle it) (the theme, and the id a move was going to give it). */
export function lockedIds(context: ThemeContext): Set<string> {
  const found = new Set<string>()
  const notes = context.db.read((sqlite) =>
    sqlite.prepare('SELECT theme_id, other_id FROM theme_swaps').all(),
  ) as { theme_id: string; other_id: string | null }[]
  for (const note of notes) {
    found.add(note.theme_id)
    if (note.other_id) found.add(note.other_id)
  }
  return found
}
