// Server-side CSS checks for themes (design docs/briefs/9-themes.md §5, "Import flow"). The browser's sanitiser judges
// what only a real CSS parser can; this is the cheap second line, run on import and on every save, that fails closed:
// CSS that matches is rejected, never edited. Escapes and comments are resolved first so `\63 ontent`, `u\72l(` and
// `con/**/tent` are caught.

import { scanThemeCss } from '@score/contract'

export const MAX_THEME_CSS_BYTES = 262_144

/** `asset:` paths a stylesheet may name: the same shape as `ThemeAssetRefSchema`, without the prefix. */
export const ASSET_PATH =
  /^(?:fonts|img)\/[A-Za-z0-9][A-Za-z0-9._-]{0,80}\.(?:woff2|png|jpg|jpeg|webp|avif)$/

/** CSS escapes: `\` + 1-6 hex digits (+ one optional whitespace), `\` + newline (a continuation), `\` + any character. */
export function unescapeCss(css: string): string {
  return css.replace(
    /\\(?:([0-9a-fA-F]{1,6})(?:\r\n|[ \t\r\n\f])?|(\r\n|[\n\r\f])|([\s\S]))/g,
    (_all, hex: string | undefined, newline: string | undefined, char: string | undefined) => {
      if (hex !== undefined) {
        const code = Number.parseInt(hex, 16)
        // Zero, surrogates and anything past U+10FFFF become U+FFFD, as the CSS parser does.
        return code === 0 || (code >= 0xd800 && code <= 0xdfff) || code > 0x10ffff
          ? '\uFFFD'
          : String.fromCodePoint(code)
      }
      return newline !== undefined ? '' : (char ?? '')
    },
  )
}

export function stripComments(css: string): string {
  // An unterminated comment runs to the end, as in a browser.
  return css.replace(/\/\*[\s\S]*?(?:\*\/|$)/g, '')
}

// The text the rules run on. Both orders are used: resolving escapes before comments would let a backslash-star opener
// hide real code (the parser does not see that as a comment), and the other order misses a comment opener that an
// escape produces.
function forms(css: string): string[] {
  return [...new Set([unescapeCss(stripComments(css)), stripComments(unescapeCss(css))])]
}

// A declaration or rule starts after `{`, `;`, `}` or the start of the text.
const PROPERTY = (name: string, value = '') => new RegExp(`(?:^|[{};\\s])${name}\\s*:${value}`, 'i')

const RULES: { reason: string; test: RegExp }[] = [
  { reason: '@import is not allowed', test: /@import/i },
  { reason: '@namespace is not allowed', test: /@namespace/i },
  { reason: '!important is not allowed', test: /!\s*important/i },
  { reason: 'expression() is not allowed', test: /expression\s*\(/i },
  { reason: 'behavior is not allowed', test: PROPERTY('behavior') },
  { reason: '-moz-binding is not allowed', test: /-moz-binding/i },
  { reason: 'javascript: is not allowed', test: /javascript\s*:/i },
  { reason: 'vbscript: is not allowed', test: /vbscript\s*:/i },
  // These load an address from a bare string, which the url() rule cannot see.
  {
    reason: 'image-set(), image(), cross-fade(), src() and paint() are not allowed',
    test: /(?:image-set|image|cross-fade|src|paint)\s*\(/i,
  },
  // Firefox's element() paints a live copy of another element (an Approve button, say) wherever the theme likes.
  { reason: 'element() is not allowed', test: /(?:^|[^a-z-])(?:-moz-)?element\s*\(/i },
]

/** The argument of every `url(` in `text`, or `null` for one that is not a plain `asset:` reference. */
function urlArguments(text: string): (string | null)[] {
  const found: (string | null)[] = []
  const start = /url\s*\(/gi
  for (let match = start.exec(text); match; match = start.exec(text)) {
    const rest = text.slice(start.lastIndex)
    const arg =
      /^\s*"([^"\\\n]*)"\s*\)/.exec(rest) ??
      /^\s*'([^'\\\n]*)'\s*\)/.exec(rest) ??
      /^\s*([^\s"'()\\]*)\s*\)/.exec(rest)
    const value = arg?.[1]
    found.push(
      value !== undefined && value.startsWith('asset:') && ASSET_PATH.test(value.slice(6))
        ? value.slice(6)
        : null,
    )
  }
  return found
}

export interface CssCheck {
  reasons: string[]
  /** Asset paths (`fonts/x.woff2`) the CSS refers to through `url(asset:…)`. */
  assets: string[]
}

export function checkThemeCss(css: string): CssCheck {
  const reasons = new Set<string>()
  // The visual-only allowlist (decision 102), shared with the browser's sanitiser: anything off it is refused, named.
  for (const finding of scanThemeCss(css)) reasons.add(`${finding.message} (${finding.rule})`)
  const assets = new Set<string>()
  if (Buffer.byteLength(css) > MAX_THEME_CSS_BYTES)
    reasons.add(`style.css is larger than ${MAX_THEME_CSS_BYTES / 1024} KB`)
  for (const text of forms(css)) {
    for (const rule of RULES) if (rule.test.test(text)) reasons.add(rule.reason)
    for (const arg of urlArguments(text)) {
      if (arg === null) reasons.add('url() may only name an asset: file of the theme')
      else assets.add(arg)
    }
  }
  return { reasons: [...reasons], assets: [...assets].sort() }
}

/** Serving: `url(asset:fonts/x.woff2)` becomes the URL Score serves that file at. */
export function rewriteAssetUrls(css: string, themeId: string): string {
  return css.replace(
    /url\(\s*(["']?)asset:((?:fonts|img)\/[A-Za-z0-9][A-Za-z0-9._-]{0,80}\.(?:woff2|png|jpg|jpeg|webp|avif))\1\s*\)/gi,
    (_all, quote: string, path: string) =>
      `url(${quote}/api/themes/${themeId}/assets/${path}${quote})`,
  )
}
