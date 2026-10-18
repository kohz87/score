import { THEME_COLOR_TOKENS } from './themes.ts'

/**
 * The visual-only CSS allowlist for themes (decision 102, Phase 9 re-gate H1). A theme's `style.css` may change how
 * things look, never where they are, how big they are, what is clipped, moved or spaced, or what is generated. The
 * browser's sanitiser (apps/web/src/themes/sanitise.ts) and the server's import check (apps/server/src/themes/css-check.ts)
 * both ask this one module, so the two can never disagree about a property or a value. Pure: no DOM, no Node APIs.
 *
 * What is not on the list is not allowed: `position`, `inset`, `top/left/…`, `transform`/`translate`/`rotate`/`scale`,
 * `overflow*`, `clip*`, `mask*`, sizes, `margin`/`padding`, `display`, flex and grid, `z-index`, `content`, `filter`,
 * `backdrop-filter`, `font-size`, `line-height`, `letter-spacing`, `word-spacing`, `text-indent`, `text-transform`,
 * `writing-mode`, `direction`, `visibility`, `pointer-events`, motion, and everything else nobody listed.
 */

export type ThemeCssRejection = 'property_not_allowed' | 'value_not_allowed'
export type ThemeDeclarationVerdict =
  { ok: true } | { ok: false; reason: ThemeCssRejection; message: string }

const GLOBAL_KEYWORDS = new Set(['inherit', 'initial', 'unset', 'revert', 'revert-layer'])
const COLOR_FUNCTIONS = new Set([
  'rgb',
  'rgba',
  'hsl',
  'hsla',
  'hwb',
  'lab',
  'lch',
  'oklab',
  'oklch',
  'color',
  'color-mix',
])

/**
 * Custom properties a theme may set: the public colour tokens (the contract's `THEME_COLOR_TOKENS`) and the corner
 * scale. The colour pairs a protected surface draws and Score's contrast check reads (`ink`/`card`/…) are set in the
 * manifest, where that check sees them, not here.
 */
const MANIFEST_ONLY_COLORS = new Set([
  'ground',
  'card',
  'ink',
  'ink-muted',
  'muted',
  'panel-ink',
  'panel-card',
])
export const THEME_CSS_CUSTOM_COLORS: readonly string[] = THEME_COLOR_TOKENS.filter(
  (token) => !MANIFEST_ONLY_COLORS.has(token),
).map((token) => `--${token}`)
export const THEME_CSS_CUSTOM_RADII = [
  '--radius-xs',
  '--radius-s',
  '--radius-m',
  '--radius-l',
  '--radius-card',
] as const
const COLOR_VARS = new Set<string>(THEME_COLOR_TOKENS.map((token) => `--${token}`))

// ---------------------------------------------------------------------------------------------------------------
// Value grammar

/** The top-level pieces of a value: split on commas (or whitespace), keeping parentheses and strings whole. */
function splitTop(text: string, separator: 'comma' | 'space'): string[] | null {
  const out: string[] = []
  let depth = 0
  let quote = ''
  let current = ''
  for (const ch of text) {
    if (quote) {
      current += ch
      if (ch === quote) quote = ''
    } else if (ch === '"' || ch === "'") {
      quote = ch
      current += ch
    } else if (ch === '(') {
      depth++
      current += ch
    } else if (ch === ')') {
      depth--
      if (depth < 0) return null
      current += ch
    } else if (depth === 0 && (separator === 'comma' ? ch === ',' : /\s/.test(ch))) {
      if (current) out.push(current)
      current = ''
    } else current += ch
  }
  if (quote || depth !== 0) return null
  if (current) out.push(current)
  return out.map((part) => part.trim()).filter(Boolean)
}

const LENGTH = /^([+-]?(?:\d+\.?\d*|\.\d+))(px|em|rem|%|vw|vh|vmin|vmax|ch|ex|pt|cm|mm|in)?$/i

/** A length or percentage as `{ value, unit }`, or null. A bare number is only a length when it is zero. */
function parseLength(token: string): { value: number; unit: string } | null {
  const match = LENGTH.exec(token)
  if (!match) return null
  const value = Number(match[1])
  const unit = (match[2] ?? '').toLowerCase()
  if (!Number.isFinite(value)) return null
  if (unit === '' && value !== 0) return null
  return { value, unit }
}

/** Rough size in CSS pixels, for the bounded properties; relative units count at a typical size. */
function pixels(length: { value: number; unit: string }): number {
  switch (length.unit) {
    case 'em':
    case 'rem':
    case 'ex':
    case 'ch':
      return length.value * 16
    case 'pt':
      return length.value * (96 / 72)
    case 'cm':
      return length.value * 37.8
    case 'mm':
      return length.value * 3.78
    case 'in':
      return length.value * 96
    case 'vw':
    case 'vh':
    case 'vmin':
    case 'vmax':
      return length.value * 20
    case '%':
      return length.value
    default:
      return length.value
  }
}

/** The inside of a colour or gradient function: characters that cannot start anything else, and only known functions. */
function safeBody(body: string, allowed: (name: string) => boolean): boolean {
  if (!/^[A-Za-z0-9\s.,%/#+()_-]*$/.test(body)) return false
  for (const match of body.matchAll(/([A-Za-z_-][A-Za-z0-9_-]*)\s*\(/g)) {
    const name = match[1]!.toLowerCase()
    if (!allowed(name)) return false
  }
  return true
}

function functionParts(token: string): { name: string; body: string } | null {
  const match = /^([A-Za-z-]+)\(([\s\S]*)\)$/.exec(token)
  if (!match) return null
  // The closing parenthesis must be the one that opens this call.
  let depth = 0
  for (let i = 0; i < token.length; i++) {
    if (token[i] === '(') depth++
    else if (token[i] === ')') {
      depth--
      if (depth === 0 && i !== token.length - 1) return null
    }
  }
  return { name: match[1]!.toLowerCase(), body: match[2]! }
}

const isColorFunctionName = (name: string) => COLOR_FUNCTIONS.has(name)

/** `var(--token)` of a public colour token, in a colour context, with no fallback. */
function isColorVar(token: string): boolean {
  const call = functionParts(token)
  if (!call || call.name !== 'var') return false
  return COLOR_VARS.has(call.body.trim())
}

function isColorToken(token: string, allowVar: boolean): boolean {
  if (/^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i.test(token)) return true
  const call = functionParts(token)
  if (call) {
    if (call.name === 'var') return allowVar && isColorVar(token)
    return (
      isColorFunctionName(call.name) &&
      safeBody(call.body, (name) => isColorFunctionName(name) || (allowVar && name === 'var')) &&
      // A var() in a colour function must name a public colour token.
      [...call.body.matchAll(/var\(([^)]*)\)/gi)].every(
        (found) => allowVar && COLOR_VARS.has(found[1]!.trim()),
      )
    )
  }
  // A keyword (red, transparent, currentcolor, a system colour): inert in a colour position.
  return /^[A-Za-z]+$/.test(token) && !GLOBAL_KEYWORDS.has(token.toLowerCase())
}

function colors(value: string, min: number, max: number, allowVar = true): boolean {
  const parts = splitTop(value, 'space')
  return (
    !!parts &&
    parts.length >= min &&
    parts.length <= max &&
    parts.every((t) => isColorToken(t, allowVar))
  )
}

const GRADIENT = /^(?:repeating-)?(?:linear|radial|conic)-gradient$/
const IMAGE_ASSET = /^asset:img\/[A-Za-z0-9][A-Za-z0-9._-]{0,80}\.(?:png|jpg|jpeg|webp|avif)$/

/** One `background-image` layer: `none`, a gradient of colours, or `url(asset:img/…)` of the theme's own image. */
function isImageLayer(token: string): boolean {
  if (token.toLowerCase() === 'none') return true
  const call = functionParts(token)
  if (!call) return false
  if (call.name === 'url') {
    const arg = call.body.trim().replace(/^(["'])([\s\S]*)\1$/, '$2')
    return IMAGE_ASSET.test(arg)
  }
  if (!GRADIENT.test(call.name)) return false
  // var() of a public colour token is fine inside a gradient; a picture, attr() and env() are not.
  if (/\burl\b|\battr\b|\benv\b|\bimage\b/i.test(call.body)) return false
  return (
    safeBody(call.body, (name) => isColorFunctionName(name) || name === 'var') &&
    [...call.body.matchAll(/var\(([^)]*)\)/gi)].every((found) => COLOR_VARS.has(found[1]!.trim()))
  )
}

const REPEAT = new Set(['repeat', 'no-repeat', 'repeat-x', 'repeat-y', 'space', 'round'])
const ATTACHMENT = new Set(['scroll', 'fixed', 'local'])
const BOX = new Set(['border-box', 'padding-box', 'content-box'])
const POSITION = new Set(['left', 'right', 'top', 'bottom', 'center'])
const BLEND = new Set([
  'normal',
  'multiply',
  'screen',
  'overlay',
  'darken',
  'lighten',
  'color-dodge',
  'color-burn',
  'hard-light',
  'soft-light',
  'difference',
  'exclusion',
  'hue',
  'saturation',
  'color',
  'luminosity',
])

function eachLayer(value: string, check: (layer: string) => boolean): boolean {
  const layers = splitTop(value, 'comma')
  return !!layers && layers.length > 0 && layers.length <= 8 && layers.every(check)
}

const lengthOrPercent = (token: string) => parseLength(token) !== null

function isPositionToken(token: string): boolean {
  return POSITION.has(token.toLowerCase()) || lengthOrPercent(token)
}

function backgroundLayer(layer: string): boolean {
  const spaced = splitTop(layer, 'space')
  if (!spaced || spaced.length === 0) return false
  // `center/cover` is three tokens; a slash inside a function (a url) is not a separator.
  const tokens = spaced.flatMap((token) =>
    token.includes('(') || !token.includes('/')
      ? [token]
      : token.split(/(\/)/).filter((part) => part !== ''),
  )
  return tokens.every((token) => {
    const lower = token.toLowerCase()
    return (
      token === '/' ||
      isImageLayer(token) ||
      REPEAT.has(lower) ||
      ATTACHMENT.has(lower) ||
      BOX.has(lower) ||
      lower === 'cover' ||
      lower === 'contain' ||
      lower === 'auto' ||
      isPositionToken(token) ||
      isColorToken(token, true)
    )
  })
}

function wordsIn(value: string, allowed: ReadonlySet<string>, min = 1, max = 4): boolean {
  const parts = splitTop(value.toLowerCase(), 'space')
  return !!parts && parts.length >= min && parts.length <= max && parts.every((p) => allowed.has(p))
}

const LINE_STYLES = new Set([
  'none',
  'hidden',
  'dotted',
  'dashed',
  'solid',
  'double',
  'groove',
  'ridge',
  'inset',
  'outset',
])
const WIDTH_WORDS = new Set(['thin', 'medium', 'thick'])
const MAX_BORDER_WIDTH = 8
const MAX_RADIUS_PX = 999

function isBorderWidth(token: string): boolean {
  if (WIDTH_WORDS.has(token.toLowerCase())) return true
  const length = parseLength(token)
  return !!length && length.unit !== '%' && length.value >= 0 && pixels(length) <= MAX_BORDER_WIDTH
}

function borderWidths(value: string, max = 4): boolean {
  const parts = splitTop(value, 'space')
  return !!parts && parts.length >= 1 && parts.length <= max && parts.every(isBorderWidth)
}

function isRadius(token: string): boolean {
  const length = parseLength(token)
  if (!length || length.value < 0) return false
  return length.unit === '%' ? length.value <= 100 : pixels(length) <= MAX_RADIUS_PX
}

function radii(value: string, longhand: boolean): boolean {
  const halves = value.split('/')
  if (halves.length > 2) return false
  return halves.every((half) => {
    const parts = splitTop(half, 'space')
    return (
      !!parts && parts.length >= 1 && parts.length <= (longhand ? 1 : 4) && parts.every(isRadius)
    )
  })
}

function borderShorthand(value: string): boolean {
  const parts = splitTop(value, 'space')
  return (
    !!parts &&
    parts.length >= 1 &&
    parts.length <= 3 &&
    parts.every(
      (part) =>
        isBorderWidth(part) || LINE_STYLES.has(part.toLowerCase()) || isColorToken(part, true),
    )
  )
}

// A shadow paints outside its element, over neighbours: bounded so it can tint but not blot out a control next to it.
const MAX_SHADOW_OFFSET = 32
const MAX_SHADOW_BLUR = 64
const MAX_SHADOW_SPREAD = 8

function shadows(value: string, kind: 'box' | 'text'): boolean {
  if (value.trim().toLowerCase() === 'none') return true
  return eachLayer(value, (layer) => {
    const parts = splitTop(layer, 'space')
    if (!parts) return false
    const numbers: { value: number; unit: string }[] = []
    let colour = 0
    let inset = 0
    for (const part of parts) {
      const length = parseLength(part)
      if (length) numbers.push(length)
      else if (part.toLowerCase() === 'inset' && kind === 'box') inset++
      else if (isColorToken(part, true)) colour++
      else return false
    }
    if (colour > 1 || inset > 1) return false
    const limit = kind === 'box' ? 4 : 3
    if (numbers.length < 2 || numbers.length > limit) return false
    if (numbers.some((n) => n.unit === '%')) return false
    const [x, y, blur, spread] = numbers.map(pixels) as [number, number, number?, number?]
    if (Math.abs(x) > MAX_SHADOW_OFFSET || Math.abs(y) > MAX_SHADOW_OFFSET) return false
    if (blur !== undefined && (blur < 0 || blur > MAX_SHADOW_BLUR)) return false
    if (spread !== undefined && (spread > MAX_SHADOW_SPREAD || spread < -MAX_SHADOW_BLUR))
      return false
    return true
  })
}

function fontFamily(value: string): boolean {
  if (value.length > 240) return false
  const families = splitTop(value, 'comma')
  return (
    !!families &&
    families.length > 0 &&
    families.length <= 8 &&
    families.every(
      (family) =>
        /^"[A-Za-z0-9][A-Za-z0-9 _.-]{0,59}"$/.test(family) ||
        /^'[A-Za-z0-9][A-Za-z0-9 _.-]{0,59}'$/.test(family) ||
        /^[A-Za-z][A-Za-z0-9_-]*(?: [A-Za-z0-9][A-Za-z0-9_-]*)*$/.test(family),
    )
  )
}

function fontWeight(value: string): boolean {
  const word = value.trim().toLowerCase()
  if (['normal', 'bold', 'bolder', 'lighter'].includes(word)) return true
  return /^\d{1,4}$/.test(word) && Number(word) >= 1 && Number(word) <= 1000
}

function decorationLine(value: string): boolean {
  return wordsIn(value, new Set(['none', 'underline']), 1, 2)
}
const DECORATION_STYLE = new Set(['solid', 'double', 'dotted', 'dashed', 'wavy'])

function decoration(value: string): boolean {
  const parts = splitTop(value, 'space')
  return (
    !!parts &&
    parts.length >= 1 &&
    parts.length <= 4 &&
    parts.every(
      (part) =>
        ['none', 'underline'].includes(part.toLowerCase()) ||
        DECORATION_STYLE.has(part.toLowerCase()) ||
        isColorToken(part, true),
    )
  )
}

function opacity(value: string): boolean {
  const text = value.trim()
  if (/^\d*\.?\d+%$/.test(text)) return Number.parseFloat(text) <= 100
  return /^(?:\d*\.?\d+)$/.test(text) && Number(text) >= 0 && Number(text) <= 1
}

function backgroundPositionList(value: string): boolean {
  return eachLayer(value, (layer) => {
    const parts = splitTop(layer, 'space')
    return !!parts && parts.length >= 1 && parts.length <= 4 && parts.every(isPositionToken)
  })
}

function backgroundSizeList(value: string): boolean {
  return eachLayer(value, (layer) => {
    const parts = splitTop(layer, 'space')
    return (
      !!parts &&
      parts.length >= 1 &&
      parts.length <= 2 &&
      parts.every(
        (part) =>
          ['cover', 'contain', 'auto'].includes(part.toLowerCase()) || lengthOrPercent(part),
      )
    )
  })
}

// ---------------------------------------------------------------------------------------------------------------
// The allowlist

type Check = (value: string) => boolean
type Entry = { check: Check; group: string }

const entries = new Map<string, Entry>()
function allow(group: string, names: readonly string[], check: Check): void {
  for (const name of names) entries.set(name, { check, group })
}

const SIDES = [
  'top',
  'right',
  'bottom',
  'left',
  'block',
  'inline',
  'block-start',
  'block-end',
  'inline-start',
  'inline-end',
]
const colorOrAuto: Check = (v) => v.trim().toLowerCase() === 'auto' || colors(v, 1, 1)

allow('Colours', ['color', 'background-color'], (v) => colors(v, 1, 1))
allow('Colours', ['accent-color', 'caret-color'], colorOrAuto)
allow('Background', ['background-image'], (v) => eachLayer(v, isImageLayer))
allow('Background', ['background-position'], backgroundPositionList)
allow('Background', ['background-size'], backgroundSizeList)
allow('Background', ['background-repeat'], (v) =>
  eachLayer(v, (layer) => wordsIn(layer, REPEAT, 1, 2)),
)
allow('Background', ['background-attachment'], (v) =>
  eachLayer(v, (layer) => wordsIn(layer, ATTACHMENT, 1, 1)),
)
allow('Background', ['background-origin'], (v) =>
  eachLayer(v, (layer) => wordsIn(layer, BOX, 1, 1)),
)
allow('Background', ['background-clip'], (v) =>
  eachLayer(v, (layer) => wordsIn(layer, new Set([...BOX, 'text']), 1, 1)),
)
allow('Background', ['background-blend-mode'], (v) =>
  eachLayer(v, (layer) => wordsIn(layer, BLEND, 1, 1)),
)
allow('Background', ['background'], (v) => eachLayer(v, backgroundLayer))
allow('Borders', ['border', ...SIDES.map((s) => `border-${s}`)], borderShorthand)
allow('Borders', ['border-color', ...SIDES.map((s) => `border-${s}-color`)], (v) => colors(v, 1, 4))
allow('Borders', ['border-style', ...SIDES.map((s) => `border-${s}-style`)], (v) =>
  wordsIn(v, LINE_STYLES, 1, 4),
)
allow('Borders', ['border-width', ...SIDES.map((s) => `border-${s}-width`)], (v) => borderWidths(v))
allow('Borders', ['border-radius'], (v) => radii(v, false))
allow(
  'Borders',
  [
    'border-top-left-radius',
    'border-top-right-radius',
    'border-bottom-left-radius',
    'border-bottom-right-radius',
    'border-start-start-radius',
    'border-start-end-radius',
    'border-end-start-radius',
    'border-end-end-radius',
  ],
  (v) => {
    const parts = splitTop(v, 'space')
    return !!parts && parts.length >= 1 && parts.length <= 2 && parts.every(isRadius)
  },
)
allow('Outline', ['outline-color'], (v) => colors(v, 1, 1))
allow('Outline', ['outline-style'], (v) => wordsIn(v, new Set([...LINE_STYLES, 'auto']), 1, 1))
allow('Shadows', ['box-shadow'], (v) => shadows(v, 'box'))
allow('Shadows', ['text-shadow'], (v) => shadows(v, 'text'))
allow('Type', ['font-family'], fontFamily)
allow('Type', ['font-weight'], fontWeight)
allow('Type', ['font-style'], (v) => wordsIn(v, new Set(['normal', 'italic', 'oblique']), 1, 1))
allow('Text decoration', ['text-decoration-line'], decorationLine)
allow('Text decoration', ['text-decoration-color'], (v) => colors(v, 1, 1))
allow('Text decoration', ['text-decoration-style'], (v) => wordsIn(v, DECORATION_STYLE, 1, 1))
allow('Text decoration', ['text-decoration'], decoration)
allow('Opacity', ['opacity'], opacity)
for (const name of THEME_CSS_CUSTOM_COLORS)
  allow('Custom properties', [name], (v) => colors(v, 1, 1, false))
allow('Custom properties', THEME_CSS_CUSTOM_RADII, (v) => {
  const length = parseLength(v.trim())
  return !!length && length.unit !== '%' && length.value >= 0 && pixels(length) <= 40
})

/** The documented allowlist, grouped, for the guide and the Customizer. */
export const THEME_CSS_ALLOWED: readonly { group: string; properties: readonly string[] }[] =
  (() => {
    const groups = new Map<string, string[]>()
    for (const [name, { group }] of entries) {
      const list = groups.get(group) ?? []
      list.push(name)
      groups.set(group, list)
    }
    return [...groups].map(([group, properties]) => ({ group, properties }))
  })()

/** Properties whose rule only applies to elements without protected descendants (the sanitiser adds the guard). */
export const THEME_CSS_NOT_ON_PROTECTED_ANCESTORS: readonly string[] = ['opacity']

/** A property name as the CSS parser sees it: case-insensitive, except custom properties. */
export function normaliseThemeProperty(name: string): string {
  const trimmed = name.trim()
  return trimmed.startsWith('--') ? trimmed : trimmed.toLowerCase()
}

export function isAllowedThemeProperty(name: string): boolean {
  return entries.has(normaliseThemeProperty(name))
}

/**
 * Is this declaration allowed in a theme? The value is the text after the colon, without `!important` (which is
 * refused elsewhere, with its own reason). `var()`, `calc()`, `attr()` and every other function a property does not
 * name are refused, so a value can never resolve to something the checks did not see.
 */
export function checkThemeDeclaration(name: string, rawValue: string): ThemeDeclarationVerdict {
  const property = normaliseThemeProperty(name)
  const entry = entries.get(property)
  if (!entry)
    return {
      ok: false,
      reason: 'property_not_allowed',
      message: `${property} can’t be set by a theme`,
    }
  const value = rawValue.trim()
  if (value === '' || value.length > 600)
    return {
      ok: false,
      reason: 'value_not_allowed',
      message: `${property}: that value isn’t allowed`,
    }
  if (GLOBAL_KEYWORDS.has(value.toLowerCase())) return { ok: true }
  return entry.check(value)
    ? { ok: true }
    : {
        ok: false,
        reason: 'value_not_allowed',
        message: `${property}: “${value.slice(0, 60)}” isn’t allowed here`,
      }
}

// ---------------------------------------------------------------------------------------------------------------
// Scanning raw CSS text (the server has no CSS engine)

export type ThemeCssFinding = {
  rule: string
  /** The property (normalised) or the at-rule (`@keyframes`) that was refused. */
  property: string
  reason: ThemeCssRejection | 'at_rule'
  message: string
}

/** At-rule blocks whose contents are rules and declarations like any others (the browser's sanitiser walks the same). */
const GROUPING_AT_RULES = new Set(['media', 'supports', 'layer', 'container'])

type Item = { text: string; end: ';' | '{' | '}' | ''; blockStart: number }

/**
 * Splits CSS the way the parser nests it, without resolving anything else: comments are skipped, a backslash escape
 * becomes the character it names but never structure (so `\3b` is not a `;`), strings and parentheses are opaque.
 * Returns the findings for every declaration and at-rule outside the allowlist.
 */
export function scanThemeCss(css: string): ThemeCssFinding[] {
  const findings: ThemeCssFinding[] = []
  let pos = 0

  const readEscape = (): string => {
    // At a backslash.
    pos++
    const hex = /^[0-9a-fA-F]{1,6}/.exec(css.slice(pos, pos + 6))
    if (hex) {
      pos += hex[0].length
      if (/^(?:\r\n|[ \t\r\n\f])/.test(css.slice(pos, pos + 2)))
        pos += css[pos] === '\r' && css[pos + 1] === '\n' ? 2 : 1
      const code = Number.parseInt(hex[0], 16)
      return code === 0 || (code >= 0xd800 && code <= 0xdfff) || code > 0x10ffff
        ? '�'
        : String.fromCodePoint(code)
    }
    if (pos >= css.length) return ''
    if (css[pos] === '\r' && css[pos + 1] === '\n') {
      pos += 2
      return ''
    }
    const ch = css[pos]!
    pos++
    return /[\n\r\f]/.test(ch) ? '' : ch
  }

  // Reads up to the next structural `;`, `{` or `}` at depth 0 (or the end), returning the decoded text.
  const readItem = (): Item => {
    let text = ''
    let depth = 0
    for (;;) {
      if (pos >= css.length) return { text, end: '', blockStart: pos }
      const ch = css[pos]!
      if (ch === '/' && css[pos + 1] === '*') {
        const close = css.indexOf('*/', pos + 2)
        pos = close < 0 ? css.length : close + 2
        text += ' '
      } else if (ch === '\\') text += readEscape()
      else if (ch === '"' || ch === "'") {
        text += ch
        pos++
        while (pos < css.length && css[pos] !== ch && css[pos] !== '\n') {
          if (css[pos] === '\\') text += readEscape()
          else text += css[pos++]
        }
        if (css[pos] === ch) {
          text += ch
          pos++
        }
      } else if (ch === '(') {
        depth++
        text += ch
        pos++
      } else if (ch === ')') {
        depth = Math.max(0, depth - 1)
        text += ch
        pos++
      } else if (depth === 0 && (ch === ';' || ch === '{' || ch === '}')) {
        pos++
        return { text, end: ch, blockStart: pos }
      } else {
        text += ch
        pos++
      }
    }
  }

  const label = (text: string) => text.replace(/\s+/g, ' ').trim().slice(0, 120)

  const block = (selector: string, top = false): void => {
    for (;;) {
      const item = readItem()
      const text = item.text.trim()
      if (item.end === '' && !text) return
      if (item.end === '}' && top && !text) continue
      if (item.end === '{') {
        if (text.startsWith('@')) {
          const name = /^@([A-Za-z-]+)/.exec(text)?.[1]?.toLowerCase() ?? ''
          if (GROUPING_AT_RULES.has(name)) block(selector)
          else {
            skipBlock()
            findings.push({
              rule: label(text),
              property: `@${name}`,
              reason: 'at_rule',
              message: `@${name} isn’t allowed in a theme`,
            })
          }
        } else block(text)
      } else {
        if (text.startsWith('@')) {
          const name = /^@([A-Za-z-]+)/.exec(text)?.[1]?.toLowerCase() ?? ''
          // @charset is ignored by the browser; @import and @namespace have their own rules; the rest do nothing a
          // theme needs.
          if (name !== 'charset' && name !== 'import' && name !== 'namespace')
            findings.push({
              rule: label(text),
              property: `@${name}`,
              reason: 'at_rule',
              message: `@${name} isn’t allowed in a theme`,
            })
        } else if (text) declaration(text, selector)
        if (item.end === '') return
        if (item.end === '}' && !top) return
      }
    }
  }

  // Skips a block we do not look inside (an at-rule that is refused as a whole).
  const skipBlock = (): void => {
    let depth = 1
    while (depth > 0 && pos < css.length) {
      const item = readItem()
      if (item.end === '{') depth++
      else if (item.end === '}') depth--
      else if (item.end === '') return
    }
  }

  const declaration = (text: string, selector: string): void => {
    const colon = text.indexOf(':')
    if (colon < 0) return
    const name = text.slice(0, colon).trim()
    let value = text.slice(colon + 1).trim()
    value = value.replace(/!\s*important\s*$/i, '').trim()
    const verdict = checkThemeDeclaration(name, value)
    if (!verdict.ok)
      findings.push({
        rule: label(`${selector ? `${selector} ` : ''}{ ${normaliseThemeProperty(name)} }`),
        property: normaliseThemeProperty(name),
        reason: verdict.reason,
        message: verdict.message,
      })
  }

  block('', true)
  return findings
}
