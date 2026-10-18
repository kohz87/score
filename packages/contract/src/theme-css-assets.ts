// The `asset:` references of a stylesheet, read the way a CSS parser reads them. One function for both readers of a
// theme package (the Customizer in apps/web and the installer in apps/server), so that what one finds missing the other
// finds missing too (third gate finding 6): a reference inside a comment or a string is not a reference, and one written
// with CSS escapes (`url(asset\3a img/a.png)`, `u\72l(…)`) is. Pure; no CSS engine.
//
// A reference is the argument of a `url()` function whose decoded text is `asset:` plus a package asset path. Other
// url() arguments are not references (the server refuses them elsewhere, the browser's sanitiser drops them).

import { THEME_ASSET_PATH } from './theme-package.ts'

const HEX = /[0-9a-fA-F]/
const isNewline = (ch: string | undefined) => ch === '\n' || ch === '\r' || ch === '\f'
const isSpace = (ch: string | undefined) => ch === ' ' || ch === '\t' || isNewline(ch)
const isNameStart = (ch: string | undefined) =>
  ch !== undefined && (/[A-Za-z_]/.test(ch) || ch.charCodeAt(0) >= 0x80)
const isNameChar = (ch: string | undefined) =>
  isNameStart(ch) || (ch !== undefined && /[0-9-]/.test(ch))

export interface CssAssetReference {
  /** The package path without the prefix: `fonts/x.woff2`. */
  path: string
  /** Where the whole `url(…)` function is in the text (end exclusive). */
  start: number
  end: number
  /** The quote the argument was written with, or '' when it was bare. */
  quote: '"' | "'" | ''
}

/** Decodes one escape that starts at `at` (the backslash). Returns the text and where the escape ends. */
function escapeAt(css: string, at: number): { text: string; next: number } {
  const first = css[at + 1]
  if (first === undefined) return { text: '�', next: at + 1 }
  if (HEX.test(first)) {
    let end = at + 1
    while (end < css.length && end - (at + 1) < 6 && HEX.test(css[end]!)) end += 1
    const code = Number.parseInt(css.slice(at + 1, end), 16)
    // One whitespace character (a CRLF pair counts as one) ends the escape.
    if (css[end] === '\r' && css[end + 1] === '\n') end += 2
    else if (isSpace(css[end])) end += 1
    const bad = code === 0 || (code >= 0xd800 && code <= 0xdfff) || code > 0x10ffff
    return { text: bad ? '�' : String.fromCodePoint(code), next: end }
  }
  // An escaped newline is not an escape at all in an identifier or url; callers treat it as the end.
  return { text: first, next: at + 2 }
}

const validEscape = (css: string, at: number) => css[at] === '\\' && !isNewline(css[at + 1])

/** Reads an identifier at `at` (escapes decoded), or null when none starts there. */
function readIdent(css: string, at: number): { text: string; next: number } | null {
  let i = at
  if (css[i] === '-') i += 1
  if (!(isNameStart(css[i]) || validEscape(css, i) || css[i] === '-')) return null
  let text = css.slice(at, i)
  while (i < css.length) {
    if (isNameChar(css[i])) {
      text += css[i]
      i += 1
    } else if (validEscape(css, i)) {
      const escape = escapeAt(css, i)
      text += escape.text
      i = escape.next
    } else break
  }
  return { text, next: i }
}

/** Reads a quoted string at `at` (the opening quote). `next` is just past the closing quote, or at a newline / the end. */
function readString(css: string, at: number): { text: string; next: number; closed: boolean } {
  const quote = css[at]
  let text = ''
  let i = at + 1
  while (i < css.length) {
    const ch = css[i]!
    if (ch === quote) return { text, next: i + 1, closed: true }
    if (isNewline(ch)) break
    if (ch === '\\') {
      if (isNewline(css[i + 1])) {
        // A backslash-newline continues the string.
        i += css[i + 1] === '\r' && css[i + 2] === '\n' ? 3 : 2
        continue
      }
      const escape = escapeAt(css, i)
      text += escape.text
      i = escape.next
      continue
    }
    text += ch
    i += 1
  }
  return { text, next: i, closed: false }
}

/** The argument of a `url(` whose opening parenthesis ended at `at`; null for a bad url (a parser drops those). */
function readUrlArgument(
  css: string,
  at: number,
): { value: string; quote: CssAssetReference['quote']; next: number } | null {
  let i = at
  while (isSpace(css[i])) i += 1
  const first = css[i]
  if (first === '"' || first === "'") {
    const string = readString(css, i)
    if (!string.closed) return null
    i = string.next
    while (isSpace(css[i])) i += 1
    return css[i] === ')' ? { value: string.text, quote: first, next: i + 1 } : null
  }
  let value = ''
  while (i < css.length) {
    const ch = css[i]!
    if (ch === ')') return { value, quote: '', next: i + 1 }
    if (isSpace(ch)) {
      while (isSpace(css[i])) i += 1
      return css[i] === ')' ? { value, quote: '', next: i + 1 } : null
    }
    if (ch === '"' || ch === "'" || ch === '(') return null
    if (ch === '\\') {
      if (isNewline(css[i + 1])) return null
      const escape = escapeAt(css, i)
      value += escape.text
      i = escape.next
      continue
    }
    value += ch
    i += 1
  }
  return null
}

/** Every `url(asset:…)` of a stylesheet that names a package asset path, in order, with where it stands. */
export function cssAssetReferences(css: string): CssAssetReference[] {
  const found: CssAssetReference[] = []
  let i = 0
  while (i < css.length) {
    const ch = css[i]!
    if (ch === '/' && css[i + 1] === '*') {
      // An unterminated comment runs to the end, as in a browser.
      const end = css.indexOf('*/', i + 2)
      i = end < 0 ? css.length : end + 2
    } else if (ch === '"' || ch === "'") {
      i = readString(css, i).next
    } else if (isNameStart(ch) || ch === '-' || ch === '\\') {
      const identStart = i
      const ident = readIdent(css, i)
      if (!ident) {
        i += 1
        continue
      }
      i = ident.next
      if (ident.text.toLowerCase() !== 'url' || css[i] !== '(') continue
      const arg = readUrlArgument(css, i + 1)
      if (!arg) continue
      i = arg.next
      if (arg.value.startsWith('asset:') && THEME_ASSET_PATH.test(arg.value.slice(6)))
        found.push({
          path: arg.value.slice(6),
          start: identStart,
          end: arg.next,
          quote: arg.quote,
        })
    } else if (ch >= '0' && ch <= '9') {
      // A number with a unit is one token (`1url(` is not a url function): skip its name characters too.
      while (isNameChar(css[i]) || css[i] === '.') i += 1
    } else i += 1
  }
  return found
}

/** The asset paths (`fonts/x.woff2`) a stylesheet refers to, sorted and without repeats. */
export function cssAssetPaths(css: string): string[] {
  return [...new Set(cssAssetReferences(css).map((ref) => ref.path))].sort()
}
