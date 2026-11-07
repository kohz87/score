import type { Snapshot } from '../../themes/customizer/snapshot.ts'

export type Source = 'new' | 'builtin' | 'imported' | 'custom'
export type Target = {
  id: string
  exists: boolean
  source: Source
  etag: string | null
  /** Where files that aren't in the draft come from, and which there are. */
  assetSource: string | null
  assets: string[]
  /** The package revision (etag) `assets` and the draft's manifest and CSS were read at; every file is fetched at it. */
  assetRev: string | null
  /** The licence files the source package has; with none, a copy has no licence to read. */
  licenseFiles: string[]
  /** Those files and licences, read once at `assetRev` when the theme was opened or copied (L1); null for a new theme. */
  snapshot: Snapshot | null
}

export type Busy = '' | 'save' | 'export' | 'use'
export type Pane = 'edit' | 'preview'
