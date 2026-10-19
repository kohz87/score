import {
  ThemeDetailSchema,
  ThemeImportResultSchema,
  type ThemeDetail,
  type ThemeImportResult,
  type ThemeManifest,
  themeAssetUrl,
} from '@score/contract'
import { ApiError, apiFetch, apiUpload, type UploadProgress } from '../../data/api.ts'
import { LICENSE_FILES } from './package.ts'
import type { SaveFiles } from './save.ts'
import { ThemeChangedError } from './snapshot.ts'
import { readZip } from './zip.ts'

// The theme API the Customizer uses (contract §16) and nothing else. Failures are put into words here.

export async function saveCustomTheme(
  manifest: ThemeManifest,
  css: string,
  etag: string | null,
  files: SaveFiles = {},
): Promise<ThemeDetail> {
  return ThemeDetailSchema.parse(
    await apiFetch(`themes/${encodeURIComponent(manifest.id)}`, {
      method: 'PUT',
      body: JSON.stringify({ manifest, css, etag, ...files }),
    }),
  )
}

export async function loadTheme(id: string): Promise<ThemeDetail> {
  return ThemeDetailSchema.parse(await apiFetch(`themes/${encodeURIComponent(id)}`))
}

/** Sends a theme zip. `replace` overwrites an installed or custom theme with the same id (never a built-in). */
export async function installThemeZip(
  bytes: Uint8Array,
  options: {
    replace?: boolean
    ifMatch?: string | null
    onProgress?: (progress: UploadProgress) => void
  } = {},
): Promise<ThemeImportResult> {
  const form = new FormData()
  form.append('file', new Blob([bytes as BlobPart], { type: 'application/zip' }), 'theme.zip')
  return ThemeImportResultSchema.parse(
    await apiUpload(
      `themes/import${options.replace ? '?replace=1' : ''}`,
      form,
      options.onProgress,
      // A replace that must not overwrite a newer version: the server compares this with the stored theme's etag.
      options.replace && options.ifMatch ? { 'If-Match': options.ifMatch } : {},
      'POST',
    ),
  )
}

/**
 * A file of an installed theme at the revision the draft was taken from. A theme replaced since then answers 409, which
 * stops the copy (ThemeChangedError) instead of delivering the newer file.
 */
export async function fetchThemeAsset(
  id: string,
  path: string,
  rev: string | null,
): Promise<Uint8Array> {
  if (!rev) throw new Error(`Couldn’t read ${path}`)
  const response = await fetch(themeAssetUrl(encodeURIComponent(id), path, rev), {
    credentials: 'same-origin',
  })
  if (response.status === 409) throw new ThemeChangedError()
  if (!response.ok) throw new Error(`Couldn’t read ${path}`)
  return new Uint8Array(await response.arrayBuffer())
}

export type SaveProblem = {
  kind: 'conflict' | 'exists' | 'locked' | 'rejected' | 'other'
  text: string
}

/** The theme was saved by someone else after this editor opened it (a stale etag, or a stale file read). */
export const CHANGED_ELSEWHERE: SaveProblem = {
  kind: 'conflict',
  text: 'This theme was changed somewhere else (another tab or device) after you opened it. Reload it to see the latest, or use Save as new to keep your version.',
}

/** What went wrong, and what to do next, without codes. */
export function describeSaveError(error: unknown): SaveProblem {
  if (error instanceof ApiError) {
    if (error.code === 'etag_mismatch') return CHANGED_ELSEWHERE
    if (error.code === 'builtin_theme')
      return {
        kind: 'locked',
        text: 'Built-in themes can’t be changed. Use Save as new to keep your version.',
      }
    if (error.code === 'theme_exists')
      return {
        kind: 'exists',
        text: 'A theme with that address is already installed. Choose another name, or replace it.',
      }
    if (error.code === 'theme_rejected') {
      const reasons = (error.details as { reasons?: unknown } | undefined)?.reasons
      const list = Array.isArray(reasons)
        ? reasons.filter((r): r is string => typeof r === 'string')
        : []
      return {
        kind: 'rejected',
        text: `Score can’t use this theme: ${list.slice(0, 3).join(' ') || error.message}`,
      }
    }
    if (error.code === 'theme_recovering')
      return {
        kind: 'other',
        text: 'Score is still putting this theme back after an interrupted change. Try again in a moment, or restart Score.',
      }
    if (error.status === 401)
      return {
        kind: 'other',
        text: 'This browser isn’t paired with Score. Pair it, then try again.',
      }
    if (error.status === 413)
      return { kind: 'other', text: 'The theme is too large. Themes can be up to 5 MB.' }
  }
  return { kind: 'other', text: 'Couldn’t reach Score. Check the connection and try again.' }
}

/** The licence texts of a theme, read from its export (they aren't part of its detail). */
export async function fetchThemeLicenses(
  id: string,
  rev: string | null,
): Promise<Record<string, string>> {
  if (!rev) throw new Error('export')
  const response = await fetch(`/api/themes/${encodeURIComponent(id)}/export?rev=${rev}`, {
    credentials: 'same-origin',
  })
  if (response.status === 409) throw new ThemeChangedError()
  if (!response.ok) throw new Error('export')
  const files = await readZip(new Uint8Array(await response.arrayBuffer()))
  const out: Record<string, string> = {}
  for (const name of LICENSE_FILES) {
    const bytes = files.get(name)
    if (bytes) out[name] = new TextDecoder('utf-8').decode(bytes)
  }
  return out
}
