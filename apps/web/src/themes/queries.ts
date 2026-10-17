import {
  LookSettingsSchema,
  ThemeDetailSchema,
  ThemeListSchema,
  type ThemeList,
  type ThemeSummary,
} from '@score/contract'
import { queryOptions } from '@tanstack/react-query'
import { apiFetch } from '../data/api.ts'
import { packs } from '../styles/packs.ts'

// Contract §16. When the server doesn't have the theme routes (an older server) or can't be reached, the app still
// offers the built-in packs, so the look picker never goes empty.
export const themesKey = ['themes'] as const

export const builtinSummaries: ThemeSummary[] = packs.map((pack) => ({
  id: pack.id,
  name: pack.name,
  version: '1.0.0',
  author: null,
  description: pack.blurb,
  source: 'builtin',
  updatedAt: '2026-10-17T00:00:00.000Z',
  hasCss: false,
}))

export const themeListQuery = queryOptions({
  queryKey: themesKey,
  queryFn: async ({ signal }): Promise<ThemeList> =>
    ThemeListSchema.parse(await apiFetch('themes', { signal })),
  retry: false,
  staleTime: 30_000,
})

export const themeDetailQuery = (id: string) =>
  queryOptions({
    queryKey: [...themesKey, id],
    queryFn: async ({ signal }) =>
      ThemeDetailSchema.parse(await apiFetch(`themes/${encodeURIComponent(id)}`, { signal })),
    retry: false,
    staleTime: 30_000,
  })

export async function saveSharedLook(settings: {
  activeTheme: string
  mode: 'light' | 'dark' | 'system'
}): Promise<void> {
  await apiFetch('look', {
    method: 'PUT',
    body: JSON.stringify(LookSettingsSchema.parse(settings)),
  })
}
