import { createHash, randomUUID } from 'node:crypto'
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import type { DatabaseSync } from 'node:sqlite'
import { z } from 'zod'
import {
  BUILTIN_THEME_IDS,
  ThemeManifestSchema,
  type ThemeDetail,
  type ThemeManifest,
  type ThemeSummary,
} from '@score/contract'
import type { ScoreDb } from '../db/index.ts'
import { BUILTIN_UPDATED_AT, builtinManifest } from './builtin.ts'

const RowSchema = z.object({
  id: z.string(),
  name: z.string(),
  version: z.string(),
  manifest_json: z.string(),
  css: z.string(),
  source: z.enum(['imported', 'custom']),
  created_at: z.string(),
  updated_at: z.string(),
})
type Row = z.infer<typeof RowSchema>

export const ASSET_DIRS = ['fonts', 'img'] as const

export interface StoredTheme {
  manifest: ThemeManifest
  css: string
  source: ThemeSummary['source']
  updatedAt: string
}

/** Hash of what a save changes (manifest and CSS), for `If`-style conflict checks. */
export function themeEtag(manifest: ThemeManifest, css: string): string {
  return createHash('sha256')
    .update(JSON.stringify(manifest))
    .update('\0')
    .update(css)
    .digest('hex')
}

/** Rows and asset folders of imported and custom themes; built-ins are constants. */
export class ThemeStore {
  readonly root: string

  constructor(
    private readonly db: ScoreDb,
    home: string,
    private readonly clock: () => number = Date.now,
  ) {
    this.root = join(home, 'themes')
  }

  private now(): string {
    return new Date(this.clock()).toISOString()
  }

  private rows(): Row[] {
    return this.db.read((sqlite) =>
      z.array(RowSchema).parse(sqlite.prepare('SELECT * FROM themes ORDER BY id').all()),
    )
  }

  private row(id: string): Row | null {
    const found = this.db.read((sqlite) =>
      sqlite.prepare('SELECT * FROM themes WHERE id = ?').get(id),
    )
    return found === undefined ? null : RowSchema.parse(found)
  }

  private parse(row: Row): StoredTheme {
    return {
      manifest: ThemeManifestSchema.parse(JSON.parse(row.manifest_json)),
      css: row.css,
      source: row.source,
      updatedAt: row.updated_at,
    }
  }

  get(id: string): StoredTheme | null {
    const manifest = builtinManifest(id)
    if (manifest) return { manifest, css: '', source: 'builtin', updatedAt: BUILTIN_UPDATED_AT }
    const row = this.row(id)
    return row ? this.parse(row) : null
  }

  exists(id: string): boolean {
    return this.get(id) !== null
  }

  summary(theme: StoredTheme): ThemeSummary {
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

  list(): ThemeSummary[] {
    const builtins = BUILTIN_THEME_IDS.map((id) => this.get(id)!)
    return [...builtins, ...this.rows().map((row) => this.parse(row))].map((t) => this.summary(t))
  }

  /** Asset paths as `fonts/x.woff2`, sorted; only regular files (a symlink planted on disk is never listed). */
  assets(id: string): string[] {
    const found: string[] = []
    for (const dir of ASSET_DIRS) {
      const folder = join(this.root, id, 'assets', dir)
      if (!existsSync(folder)) continue
      for (const name of readdirSync(folder).sort()) {
        if (lstatSync(join(folder, name)).isFile()) found.push(`${dir}/${name}`)
      }
    }
    return found
  }

  detail(id: string): ThemeDetail | null {
    const theme = this.get(id)
    if (!theme) return null
    return {
      summary: this.summary(theme),
      manifest: theme.manifest,
      css: theme.css,
      assets: this.assets(id),
      etag: themeEtag(theme.manifest, theme.css),
    }
  }

  /** Inserts or replaces the row of an imported or custom theme. `createdAt` is kept on a replace. */
  upsert(
    sqlite: DatabaseSync,
    manifest: ThemeManifest,
    css: string,
    source: 'imported' | 'custom',
  ): void {
    const at = this.now()
    sqlite
      .prepare(
        `INSERT INTO themes (id, name, version, manifest_json, css, source, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (id) DO UPDATE SET name = excluded.name, version = excluded.version,
           manifest_json = excluded.manifest_json, css = excluded.css, source = excluded.source,
           updated_at = excluded.updated_at`,
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
      )
  }

  /** Saves a custom theme's manifest and CSS in one transaction (assets already on disk are kept). */
  saveCustom(manifest: ThemeManifest, css: string): void {
    this.db.tx((sqlite) => this.upsert(sqlite, manifest, css, 'custom'))
  }

  /**
   * Stores an imported theme: the assets are staged in a private folder, swapped in, then the row is written; if the
   * row fails the previous folder comes back. Files are 0600, folders 0700.
   */
  storeImported(manifest: ThemeManifest, css: string, assets: Map<string, Buffer>): void {
    mkdirSync(this.root, { recursive: true, mode: 0o700 })
    chmodSync(this.root, 0o700)
    const token = randomUUID()
    const staged = join(this.root, `.staging-${token}`)
    const target = join(this.root, manifest.id)
    const old = join(this.root, `.old-${token}`)
    try {
      mkdirSync(join(staged, 'assets'), { recursive: true, mode: 0o700 })
      for (const dir of ASSET_DIRS) mkdirSync(join(staged, 'assets', dir), { mode: 0o700 })
      for (const [path, bytes] of assets) {
        const file = join(staged, 'assets', ...path.split('/'))
        writeFileSync(file, bytes, { mode: 0o600, flag: 'wx' })
        chmodSync(file, 0o600)
      }
      const hadOld = existsSync(target)
      if (hadOld) renameSync(target, old)
      renameSync(staged, target)
      try {
        this.db.tx((sqlite) => this.upsert(sqlite, manifest, css, 'imported'))
      } catch (error) {
        rmSync(target, { recursive: true, force: true })
        if (hadOld) renameSync(old, target)
        throw error
      }
      rmSync(old, { recursive: true, force: true })
    } finally {
      rmSync(staged, { recursive: true, force: true })
    }
  }

  /** Removes the row and the folder; the caller has already refused built-ins and the active theme. */
  remove(id: string): void {
    this.db.tx((sqlite) => sqlite.prepare('DELETE FROM themes WHERE id = ?').run(id))
    rmSync(join(this.root, id), { recursive: true, force: true })
  }
}
