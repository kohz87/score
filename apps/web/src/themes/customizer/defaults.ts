import {
  THEME_COLOR_TOKENS,
  ThemeColorSchema,
  type ThemeColorToken,
  type ThemeManifest,
} from '@score/contract'
import { emptyManifest, tidy, type Mode } from './draft.ts'
import type { Probe } from './frame-document.ts'
import { builtinFontFamilies } from '../engine.ts'
import { findPack, packs } from '../../styles/packs.ts'

// What the built-in looks are, as values. Score's own look and the 8.3 packs are written as CSS (tokens.css,
// packs/*.css), not as manifests, so the Customizer reads them back from the browser: a hidden frame wearing the
// pack's attributes tells which value each public token has. Start-from-a-built-in copies those values.

// Not defined in tokens.css: the chat falls back to these.
const FALLBACKS: Partial<Record<ThemeColorToken, ThemeColorToken>> = {
  'bubble-own': 'ink',
  'bubble-own-ink': 'card',
}

/** Score's own value of a colour token in a mode ('' when the stylesheets don't say). */
export function defaultColor(probe: Probe, token: ThemeColorToken, mode: Mode): string {
  const direct = probe.read('score', mode, `--${token}`)
  const fallback = FALLBACKS[token]
  return direct || (fallback ? probe.read('score', mode, `--${fallback}`) : '')
}

function firstFamily(stack: string): string {
  const match = /^\s*(?:'([^']+)'|"([^"]+)"|([A-Za-z0-9 -]+?))\s*(?:,|$)/.exec(stack)
  return (match?.[1] ?? match?.[2] ?? match?.[3] ?? '').trim()
}

/** A new manifest that looks like a built-in pack (the values the pack's CSS gives), under a new id and name. */
export function manifestFromPack(
  probe: Probe,
  packId: string,
  id: string,
  name: string,
): ThemeManifest {
  const pack = findPack(packId)
  const manifest = emptyManifest(id, name)
  if (!packs.some((item) => item.id === packId) || packId === 'score') return manifest
  const colors: NonNullable<ThemeManifest['colors']> = {}
  for (const mode of ['light', 'dark'] as const) {
    const set: Record<string, string> = {}
    for (const token of THEME_COLOR_TOKENS) {
      const value = probe.read(packId, mode, `--${token}`)
      if (
        value &&
        value !== probe.read('score', mode, `--${token}`) &&
        ThemeColorSchema.safeParse(value).success
      )
        set[token] = value
    }
    colors[mode] = set
  }
  const radius = Number.parseInt(probe.read(packId, 'light', '--radius-card'), 10)
  const baseRadius = Number.parseInt(probe.read('score', 'light', '--radius-card'), 10)
  if (Number.isFinite(radius) && radius !== baseRadius)
    manifest.shape = { ...manifest.shape, radius: Math.min(40, Math.max(0, radius)) }
  const fonts: NonNullable<ThemeManifest['fonts']> = {}
  for (const key of ['heading', 'body', 'code'] as const) {
    const family = firstFamily(probe.read(packId, 'light', `--font-${key}`))
    if (
      family !== firstFamily(probe.read('score', 'light', `--font-${key}`)) &&
      (builtinFontFamilies as readonly string[]).includes(family)
    )
      fonts[key] = family
  }
  if (Object.keys(fonts).length) manifest.fonts = fonts
  manifest.colors = colors
  if (pack.density === 'compact') manifest.shape = { ...manifest.shape, density: 'compact' }
  if (pack.layout === 'side') manifest.layout = { ...manifest.layout, nav: 'left' }
  return tidy(manifest)
}
