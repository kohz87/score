import {
  THEME_COLOR_TOKENS,
  ThemeAssetRefSchema,
  ThemeColorSchema,
  ThemeIdSchema,
  ThemeRevSchema,
  themeAssetUrl,
  type ThemeColorToken,
} from '@score/contract'
import { applyPack } from '../data/pack.ts'
import { findPack, packs } from '../styles/packs.ts'
import { contrastRatio, parseComputedColor } from './color.ts'
import { lookForView, resolveLayout, type Look, type LookView } from './layout.ts'
import { sanitiseCss } from './sanitise.ts'

// The theme engine (PLAN 9.2, design docs/briefs/9-themes.md §6): a manifest becomes <html> attributes, a generated
// token sheet, namespaced @font-face rules, a background and the theme's own sanitised CSS. Everything lands in
// adopted style sheets, which the cascade orders after every stylesheet of the app, so Score's CSS stays unlayered
// and the default look stays exactly as it was. Only the public colour tokens are ever written.

export type ColorMode = 'light' | 'dark'

/** Attributes the engine owns on <html>; boot-look.js restores the same set from the cache. */
export const LOOK_ATTRIBUTES = [
  'data-radius',
  'data-elevation',
  'data-surface',
  'data-border',
  'data-nav',
  'data-width',
  'data-chat',
  'data-rooms',
  'data-backdrop',
  'data-look',
  'data-contrast-fallback',
] as const

export const builtinThemeIds: readonly string[] = packs.map((pack) => pack.id)
export function isBuiltinTheme(id: string): boolean {
  return builtinThemeIds.includes(id)
}

// Score's own pairs (tokens.css), for the contrast check when a theme sets only one side of a pair.
const defaultColors: Record<ColorMode, Partial<Record<ThemeColorToken, string>>> = {
  light: {
    ground: '#eceef2',
    card: '#ffffff',
    ink: '#12131a',
    'ink-muted': '#5e626c',
    muted: '#626670',
    'panel-ink': '#12131a',
    'panel-card': '#ffffff',
  },
  dark: {
    ground: '#0f1116',
    card: '#181a21',
    ink: '#eceef2',
    'ink-muted': '#a9adb8',
    muted: '#9fa3ae',
    'panel-ink': '#242733',
    'panel-card': '#ffffff',
  },
}
export const defaultColorPairs = defaultColors

const defaultFonts = {
  heading: "'Bricolage Grotesque', 'Hanken Grotesk', sans-serif",
  body: "'Hanken Grotesk', ui-sans-serif, system-ui, sans-serif",
  code: "'JetBrains Mono', ui-monospace, monospace",
} as const

/** The theme's font names are written into CSS, so only this shape (the contract's) is ever accepted. */
const SAFE_FAMILY = /^[A-Za-z0-9][A-Za-z0-9 _-]{0,59}$/

function colorsFor(look: Look, mode: ColorMode): Partial<Record<ThemeColorToken, string>> {
  const set = look.colors?.[mode] as Record<string, unknown> | undefined
  const out: Partial<Record<ThemeColorToken, string>> = {}
  if (!set) return out
  for (const token of THEME_COLOR_TOKENS) {
    const value = set[token]
    if (typeof value === 'string' && ThemeColorSchema.safeParse(value).success) out[token] = value
  }
  return out
}

function declarations(colors: Partial<Record<ThemeColorToken, string>>): string {
  return Object.entries(colors)
    .map(([token, value]) => `--${token}:${value};`)
    .join('')
}

/** A font face of a theme gets its own family name, so it can never replace one of Score's fonts. */
export function faceFamily(themeId: string, family: string): string {
  return `theme-${themeId}-${family.replace(/ /g, '-')}`
}

/**
 * The URL of a theme's file for the package revision the caller holds (contract § 16, J1: the server refuses a stale
 * one). Without a valid revision there is no URL, so nothing unversioned is ever painted.
 */
export function assetUrl(
  themeId: string,
  ref: string,
  rev: string | null | undefined,
): string | null {
  if (
    !ThemeIdSchema.safeParse(themeId).success ||
    !ThemeAssetRefSchema.safeParse(ref).success ||
    !ThemeRevSchema.safeParse(rev).success
  )
    return null
  return themeAssetUrl(themeId, ref.slice('asset:'.length), rev as string)
}

/** Where an `asset:` reference points. The Customizer's draft answers with pictures and fonts not saved yet. */
export type AssetResolver = (ref: string) => string | null

/** The resolver for an installed theme at the revision (its etag) the caller loaded. */
export const assetResolver =
  (themeId: string, rev: string | null | undefined): AssetResolver =>
  (ref) =>
    assetUrl(themeId, ref, rev)

function fontStack(look: Look, themeId: string, key: 'heading' | 'body' | 'code'): string | null {
  const family = look.fonts?.[key]
  if (typeof family !== 'string' || !SAFE_FAMILY.test(family)) return null
  const own = look.fonts?.faces?.some((face) => face.family === family)
  return `"${own ? faceFamily(themeId, family) : family}", ${defaultFonts[key]}`
}

function radiusCss(shape: Look['shape']): string {
  const radius = shape?.radius
  if (typeof radius !== 'number' || !Number.isFinite(radius)) return ''
  const n = Math.min(40, Math.max(0, Math.round(radius)))
  const px = (factor: number) => `${Math.round(n * factor)}px`
  return `--radius-xs:${px(0.2)};--radius-s:${px(0.3)};--radius-m:${px(0.5)};--radius-l:${px(0.7)};--radius-card:${n}px;`
}

// `:root:root` raises the specificity by one class so the sheet wins wherever it sits in the cascade: the boot copy
// (public/boot-look.js) lands in <head> before the app's stylesheets.
const SCOPE = ":root:root[data-look='custom']"

/** The generated token sheet: colours for both modes, fonts, numeric radius. No theme-controlled text but validated tokens. */
export function tokenCss(look: Look, themeId: string): string {
  const light = declarations(colorsFor(look, 'light'))
  const dark = declarations(colorsFor(look, 'dark'))
  const fonts = (['heading', 'body', 'code'] as const)
    .map((key) => {
      const stack = fontStack(look, themeId, key)
      return stack ? `--font-${key}:${stack};` : ''
    })
    .join('')
  const shared = fonts + radiusCss(look.shape)
  const parts = [`${SCOPE}{${shared}}`]
  if (light) {
    parts.push(`${SCOPE}[data-theme='light']{${light}}`)
    parts.push(`@media not (prefers-color-scheme: dark){${SCOPE}:not([data-theme]){${light}}}`)
  }
  if (dark) {
    parts.push(`${SCOPE}[data-theme='dark']{${dark}}`)
    parts.push(`@media (prefers-color-scheme: dark){${SCOPE}:not([data-theme]){${dark}}}`)
  }
  return parts.join('\n')
}

export function fontFaceCss(
  look: Look,
  themeId: string,
  resolve: AssetResolver = assetResolver(themeId, null),
): string {
  const faces = look.fonts?.faces ?? []
  return faces
    .flatMap((face) => {
      const url = ThemeAssetRefSchema.safeParse(face.src).success ? resolve(face.src) : null
      if (!url || !SAFE_FAMILY.test(face.family)) return []
      const weight = /^[1-9]00( [1-9]00)?$/.test(face.weight) ? face.weight : '400'
      const style = face.style === 'italic' ? 'italic' : 'normal'
      return [
        `@font-face{font-family:"${faceFamily(themeId, face.family)}";src:url("${url}") format("woff2");font-weight:${weight};font-style:${style};font-display:swap}`,
      ]
    })
    .join('\n')
}

export function backgroundCss(
  look: Look,
  themeId: string,
  resolve: AssetResolver = assetResolver(themeId, null),
): string {
  const image = look.background?.image
  const url = image && ThemeAssetRefSchema.safeParse(image).success ? resolve(image) : null
  if (!url) return ''
  const dim = Math.min(80, Math.max(0, Math.round(look.background?.dim ?? 0)))
  const veil = `color-mix(in srgb, var(--ground) ${dim}%, transparent)`
  const tile = look.background?.fit === 'tile'
  return `${SCOPE} body{background-image:linear-gradient(${veil},${veil}),url("${url}");background-size:${tile ? 'auto' : 'cover'};background-repeat:${tile ? 'repeat' : 'no-repeat'};background-attachment:fixed;background-position:center}`
}

/** The `data-*` attributes a manifest asks for (only values the contract allows are written). */
export function themeAttributes(look: Look): Record<string, string> {
  const out: Record<string, string> = { 'data-look': 'custom' }
  const { shape, layout } = look
  const radius = shape?.radius
  if (typeof radius === 'number') out['data-radius'] = 'custom'
  else if (radius) out['data-radius'] = radius
  if (shape?.border) out['data-border'] = shape.border
  if (shape?.elevation) out['data-elevation'] = shape.elevation
  if (shape?.surface) out['data-surface'] = shape.surface
  if (layout?.nav) out['data-nav'] = layout.nav
  if (layout?.contentWidth) out['data-width'] = layout.contentWidth
  if (layout?.chat?.messages) out['data-chat'] = layout.chat.messages
  if (layout?.chat?.roomList)
    out['data-rooms'] =
      layout.chat.roomList === 'hidden-until-opened' ? 'hidden' : layout.chat.roomList
  // Full-bleed containers that paint the ground over the page let the picture through.
  if (look.background?.image && ThemeAssetRefSchema.safeParse(look.background.image).success)
    out['data-backdrop'] = look.background.fit === 'tile' ? 'tile' : 'cover'
  return out
}

/**
 * True when a pair a protected surface draws fails WCAG AA (4.5:1) with the theme's colours: the surface then falls
 * back to Score's own pairs (data-contrast-fallback, styles/protected.css).
 */
export function failsProtectedContrast(look: Look, mode: ColorMode): boolean {
  const colors = { ...defaultColors[mode], ...colorsFor(look, mode) }
  const rgba = (token: ThemeColorToken) => parseComputedColor(colors[token] ?? '')
  const pairs: [ThemeColorToken, ThemeColorToken][] = [
    ['ink', 'card'],
    ['ink-muted', 'card'],
    ['muted', 'card'],
    ['ink', 'ground'],
    ['card', 'ink'],
    ['panel-card', 'panel-ink'],
    ['panel-ink', 'panel-card'],
  ]
  return pairs.some(([text, background]) => {
    const fg = rgba(text)
    const bg = rgba(background)
    // A translucent pair is no pair: protected controls wear the card colour as an opaque background.
    return !fg || !bg || fg[3] < 1 || bg[3] < 1 || contrastRatio(fg, bg) < 4.5
  })
}

type Applied = { sheets: CSSStyleSheet[]; fallbackElements: HTMLStyleElement[] }
let applied: Applied = { sheets: [], fallbackElements: [] }

function supportsAdopted(): boolean {
  return (
    typeof CSSStyleSheet !== 'undefined' &&
    'replaceSync' in CSSStyleSheet.prototype &&
    Array.isArray(document.adoptedStyleSheets)
  )
}

function setAdopted(texts: string[]): {
  sheets: CSSStyleSheet[]
  fallbackElements: HTMLStyleElement[]
} {
  applied.fallbackElements.forEach((element) => element.remove())
  if (!supportsAdopted()) {
    const elements = texts.map((text) => {
      const element = document.createElement('style')
      element.dataset.scoreLook = ''
      element.textContent = text
      document.head.append(element)
      return element
    })
    return { sheets: [], fallbackElements: elements }
  }
  const keep = document.adoptedStyleSheets.filter((sheet) => !applied.sheets.includes(sheet))
  const sheets = texts.map((text) => {
    const sheet = new CSSStyleSheet()
    sheet.replaceSync(text)
    return sheet
  })
  document.adoptedStyleSheets = [...keep, ...sheets]
  return { sheets, fallbackElements: [] }
}

// Source Serif 4 and Inter ship with the packs that use them and load on first use. A custom theme (a copy of Paper,
// say) may name them too, so they load for it as well.
const packFontFamilies: Record<string, string> = { 'Source Serif 4': 'paper', Inter: 'dense' }
export const builtinFontFamilies = [
  'Bricolage Grotesque',
  'Hanken Grotesk',
  'JetBrains Mono',
  ...Object.keys(packFontFamilies),
] as const

export function loadBuiltinFonts(look: Look): void {
  for (const key of ['heading', 'body', 'code'] as const) {
    const family = look.fonts?.[key]
    const packId = family ? packFontFamilies[family] : undefined
    if (packId)
      void findPack(packId)
        .fonts?.()
        .catch(() => {
          // The fallback font shows.
        })
  }
}

/** Removes the sheets and attributes of a custom theme; the document is back at the unthemed Score look. */
export function clearLook(): void {
  const root = document.documentElement
  applied.fallbackElements.forEach((element) => element.remove())
  if (supportsAdopted())
    document.adoptedStyleSheets = document.adoptedStyleSheets.filter(
      (sheet) => !applied.sheets.includes(sheet),
    )
  applied = { sheets: [], fallbackElements: [] }
  for (const name of LOOK_ATTRIBUTES) root.removeAttribute(name)
  document.getElementById('score-look-boot')?.remove()
}

/** Switches to a built-in pack (the 8.3 themes): same attributes as before, no sheets. */
export function applyBuiltin(id: string): void {
  clearLook()
  applyPack(findPack(id))
}

/** `etag` is the revision the files are asked for; without it a theme's fonts and pictures are not loaded. */
export type LookDetail = { id: string; manifest: Look; css: string; etag?: string }
/** What the boot script paints before React starts: the <html> attributes and the generated token sheet. */
export type CachedLook = { attributes: Record<string, string>; css: string; layout: Look['layout'] }
export type AppliedLook = {
  report: ReturnType<typeof sanitiseCss>['report']
  contrastFallback: boolean
  cache: CachedLook
  /** The same for the retired user view (`views.user` laid over the theme), kept for old theme tests. */
  userCache: CachedLook
  layout: ReturnType<typeof resolveLayout>
}

/** Everything the page wears for one view of a theme: the attributes, the generated sheet and the layout. */
export function lookParts(
  manifest: Look,
  themeId: string,
  mode: ColorMode,
  view: LookView,
  resolve?: AssetResolver,
): { attributes: Record<string, string>; css: string; contrastFallback: boolean; look: Look } {
  const look = lookForView(manifest, view)
  const contrastFallback = failsProtectedContrast(look, mode)
  const nav = look.layout?.nav
  const attributes: Record<string, string> = {
    ...themeAttributes(look),
    // Score's own layout/density attributes: a custom theme starts from the default pack. Both rails use the side
    // layout; the right one is mirrored by data-nav (shell.css).
    'data-pack': 'score',
    'data-layout': nav === 'left' || nav === 'right' ? 'side' : 'top',
    'data-density': look.shape?.density ?? 'comfortable',
    ...(contrastFallback ? { 'data-contrast-fallback': '' } : {}),
  }
  const css = [
    tokenCss(look, themeId),
    fontFaceCss(look, themeId, resolve),
    backgroundCss(look, themeId, resolve),
  ]
    .filter(Boolean)
    .join('\n')
  return { attributes, css, contrastFallback, look }
}

/**
 * Applies a custom theme: attributes, token sheet, font faces, background and the sanitised theme CSS, in that
 * cascade order. Throws when something is wrong; the caller skips the theme (the engine leaves the look cleared).
 * `view` is kept for the Customizer and old theme checks; the app itself always wears `admin`.
 */
export function applyCustom(
  detail: LookDetail,
  mode: ColorMode,
  view: LookView = 'admin',
): AppliedLook {
  clearLook()
  try {
    if (!ThemeIdSchema.safeParse(detail.id).success) throw new Error('Invalid theme id')
    const root = document.documentElement
    const resolve = assetResolver(detail.id, detail.etag)
    const admin = lookParts(detail.manifest, detail.id, mode, 'admin', resolve)
    const user = lookParts(detail.manifest, detail.id, mode, 'user', resolve)
    const main = view === 'user' ? user : admin
    const { css: cleaned, report } = sanitiseCss(detail.css, {
      themeId: detail.id,
      rev: detail.etag,
      confine: true,
    })
    applied = setAdopted([main.css, cleaned].filter(Boolean))
    for (const [name, value] of Object.entries(main.attributes)) root.setAttribute(name, value)
    loadBuiltinFonts(main.look)
    const asCache = (parts: typeof main): CachedLook => ({
      attributes: parts.attributes,
      css: parts.css,
      layout: parts.look.layout,
    })
    return {
      report,
      contrastFallback: main.contrastFallback,
      cache: asCache(admin),
      userCache: asCache(user),
      layout: resolveLayout(main.look),
    }
  } catch (error) {
    clearLook()
    throw error
  }
}

/** The sheets the engine added, for the guard that temporarily lifts them (themes/guard.ts). */
export function appliedThemeSheets(): readonly CSSStyleSheet[] {
  return applied.sheets
}
export function appliedThemeElements(): readonly HTMLStyleElement[] {
  return applied.fallbackElements
}
