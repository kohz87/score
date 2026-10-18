import {
  ThemeDetailSchema,
  ThemeImportResultSchema,
  type ThemeDetail,
  type ThemeImportResult,
  type ThemeManifest,
} from '@score/contract'
import { ApiError, apiFetch } from '../../data/api.ts'

// The theme API the Customizer uses (contract §16) and nothing else. Failures are put into words here.

export async function saveCustomTheme(
  manifest: ThemeManifest,
  css: string,
  etag: string | null,
): Promise<ThemeDetail> {
  return ThemeDetailSchema.parse(
    await apiFetch(`themes/${encodeURIComponent(manifest.id)}`, {
      method: 'PUT',
      body: JSON.stringify({ manifest, css, etag }),
    }),
  )
}

export async function loadTheme(id: string): Promise<ThemeDetail> {
  return ThemeDetailSchema.parse(await apiFetch(`themes/${encodeURIComponent(id)}`))
}

/** Sends a theme zip. `replace` overwrites an installed or custom theme with the same id (never a built-in). */
export async function installThemeZip(
  bytes: Uint8Array,
  options: { replace?: boolean } = {},
): Promise<ThemeImportResult> {
  const form = new FormData()
  form.append('file', new Blob([bytes as BlobPart], { type: 'application/zip' }), 'theme.zip')
  return ThemeImportResultSchema.parse(
    await apiFetch(`themes/import${options.replace ? '?replace=1' : ''}`, {
      method: 'POST',
      body: form,
    }),
  )
}

export async function fetchThemeAsset(id: string, path: string): Promise<Uint8Array> {
  const response = await fetch(`/api/themes/${encodeURIComponent(id)}/assets/${path}`, {
    credentials: 'same-origin',
  })
  if (!response.ok) throw new Error(`Couldn’t read ${path}`)
  return new Uint8Array(await response.arrayBuffer())
}

export type SaveProblem = {
  kind: 'conflict' | 'exists' | 'locked' | 'rejected' | 'other'
  text: string
}

/** What went wrong, and what to do next, without codes. */
export function describeSaveError(error: unknown): SaveProblem {
  if (error instanceof ApiError) {
    if (error.code === 'etag_mismatch')
      return {
        kind: 'conflict',
        text: 'This theme was changed somewhere else (another tab or device) after you opened it. Reload it to see the latest, or use Save as new to keep your version.',
      }
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
