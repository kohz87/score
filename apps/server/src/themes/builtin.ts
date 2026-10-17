import { BUILTIN_THEME_IDS, THEME_FORMAT, type ThemeManifest } from '@score/contract'

// The built-ins' real look lives in the web app (9.2); the server only needs their identity, so the list and the
// export have something honest to say.
const NAMES: Record<(typeof BUILTIN_THEME_IDS)[number], string> = {
  score: 'Score',
  paper: 'Paper',
  night: 'Night shift',
  dense: 'Dense',
}
export const BUILTIN_UPDATED_AT = '2026-10-17T00:00:00.000Z'

export function isBuiltinThemeId(id: string): boolean {
  return (BUILTIN_THEME_IDS as readonly string[]).includes(id)
}

export function builtinManifest(id: string): ThemeManifest | null {
  const name = (NAMES as Record<string, string | undefined>)[id]
  if (name === undefined) return null
  return {
    format: THEME_FORMAT,
    id,
    name,
    version: '1.0.0',
    author: 'Score',
  } satisfies ThemeManifest
}
