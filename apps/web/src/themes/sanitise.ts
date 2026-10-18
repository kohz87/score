import type { ThemeSanitiseReport } from '@score/contract'
import {
  THEME_CSS_NOT_ON_PROTECTED_ANCESTORS,
  ThemeAssetRefSchema,
  ThemeIdSchema,
  checkThemeDeclaration,
  checkThemeSelector,
  isAllowedThemeProperty,
  normaliseThemeProperty,
} from '@score/contract'
import { protectedClasses, protectedCustomPropertyPrefixes } from './protected-surfaces.ts'

// The theme CSS sanitiser (design §4.1). The browser's own parser reads the text (escapes are resolved by it, so
// `\63 ontent` is `content`), every rule is checked, and only what passes is written back out. Anything the parser
// can't give us drops everything: a theme without CSS is a safe theme.

type Reason = ThemeSanitiseReport['dropped'][number]['reason']
export type SanitiseResult = { css: string; report: ThemeSanitiseReport }

// A prefix match: `.chat-approval-command` and `.agent-glyph__ring` belong to their component too.
const classPattern = new RegExp(`\\.(${protectedClasses.join('|')})`, 'i')
const GROUPING = new Set([
  'CSSMediaRule',
  'CSSSupportsRule',
  'CSSLayerBlockRule',
  'CSSContainerRule',
])
function selectorReaches(text: string): boolean {
  const lower = text.toLowerCase()
  return (
    lower.includes('data-protected') ||
    classPattern.test(lower) ||
    lower.includes('score-protected')
  )
}

/** Splits a declaration block on the semicolons that are outside parentheses and quotes. */
export function splitDeclarations(block: string): string[] {
  const out: string[] = []
  let depth = 0
  let quote = ''
  let start = 0
  for (let i = 0; i < block.length; i++) {
    const ch = block[i]
    if (quote) {
      if (ch === '\\') i++
      else if (ch === quote) quote = ''
    } else if (ch === '"' || ch === "'") quote = ch
    else if (ch === '(') depth++
    else if (ch === ')') depth = Math.max(0, depth - 1)
    else if (ch === ';' && depth === 0) {
      out.push(block.slice(start, i))
      start = i + 1
    }
  }
  out.push(block.slice(start))
  return out.map((part) => part.trim()).filter(Boolean)
}

/**
 * Theme rules never match inside a protected subtree (design §4.3, gate finding #3/#5): every selector of the cleaned
 * sheet gets this zero-specificity guard, so the theme can't restyle an approval's text, a glyph's paths or a
 * button inside a decision surface by tag, attribute or position. It is the "donut scope" of `@scope (:root) to
 * ([data-protected])`, spelled in selectors every browser understands (`@scope` would also stop `html …` rules from
 * matching and needs Firefox 146+); `:where()` keeps the specificity the author wrote.
 */
export const OUTSIDE_PROTECTED = ':where(:not([data-protected], [data-protected] *))'

/**
 * `opacity` is the one allowed property that also dims everything inside (re-gate finding 3/4): it only applies to
 * elements that have no protected element inside them.
 */
export const WITHOUT_PROTECTED_INSIDE = ':where(:not(:has([data-protected])))'

/** Where the guard goes: before the pseudo-element of the last compound, else at the end. */
export function confineSelector(selectorText: string, extraGuard = ''): string {
  const parts: string[] = []
  let depth = 0
  let quote = ''
  let start = 0
  for (let i = 0; i < selectorText.length; i++) {
    const ch = selectorText[i]
    if (quote) {
      if (ch === '\\') i++
      else if (ch === quote) quote = ''
    } else if (ch === '\\') i++
    else if (ch === '"' || ch === "'") quote = ch
    else if (ch === '(' || ch === '[') depth++
    else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1)
    else if (ch === ',' && depth === 0) {
      parts.push(selectorText.slice(start, i))
      start = i + 1
    }
  }
  parts.push(selectorText.slice(start))
  return parts
    .map((part) => part.trim())
    .filter(Boolean)
    .map((part) => insertGuard(part, extraGuard))
    .join(', ')
}

function insertGuard(selector: string, extraGuard: string): string {
  let depth = 0
  let quote = ''
  for (let i = 0; i < selector.length; i++) {
    const ch = selector[i]
    if (quote) {
      if (ch === '\\') i++
      else if (ch === quote) quote = ''
    } else if (ch === '\\') i++
    else if (ch === '"' || ch === "'") quote = ch
    else if (ch === '(' || ch === '[') depth++
    else if (ch === ')' || ch === ']') depth = Math.max(0, depth - 1)
    else if (
      ch === ':' &&
      depth === 0 &&
      (selector[i + 1] === ':' ||
        /^:(before|after|first-line|first-letter)(?![\w-])/i.test(selector.slice(i)))
    )
      return `${selector.slice(0, i)}${OUTSIDE_PROTECTED}${extraGuard}${selector.slice(i)}`
  }
  return `${selector}${OUTSIDE_PROTECTED}${extraGuard}`
}

type Context = {
  confine: boolean
  themeId: string | null
  resolve?: (ref: string) => string | null
  report: ThemeSanitiseReport['dropped']
}

function drop(context: Context, rule: string, reason: Reason): void {
  context.report.push({ rule: rule.replace(/\s+/g, ' ').slice(0, 200), reason })
}

/** Every `url(...)` of a value must be `asset:` (rewritten to the theme's own asset URL when the id is known). */
function cleanUrls(value: string, context: Context): string | null {
  if (
    /image-set\(|-webkit-image-set\(|(^|[^a-z-])src\(|element\(|expression\(|javascript:/i.test(
      value,
    )
  )
    return null
  let ok = true
  const rewritten = value.replace(
    /url\(\s*(["']?)(.*?)\1\s*\)/gi,
    (_whole, _quote, target: string) => {
      const ref = target.trim()
      if (!ref.startsWith('asset:') || !ThemeAssetRefSchema.safeParse(ref).success) {
        ok = false
        return ''
      }
      const resolved = context.resolve?.(ref)
      if (resolved) return `url("${resolved}")`
      if (!context.themeId || !ThemeIdSchema.safeParse(context.themeId).success)
        return `url("${ref}")`
      return `url("/api/themes/${context.themeId}/assets/${ref.slice('asset:'.length)}")`
    },
  )
  if (!ok || /url\(/i.test(rewritten.replace(/url\("[^"]*"\)/gi, ''))) return null
  return rewritten
}

type Kept = { name: string; value: string }

/** The declarations of one rule that may stay; a null result drops the whole rule (it carried `!important`). */
function cleanDeclarations(
  cssText: string,
  context: Context,
  label: string,
): { kept: Kept[]; important: boolean } {
  const kept: Kept[] = []
  let important = false
  for (const declaration of splitDeclarations(cssText)) {
    const colon = declaration.indexOf(':')
    if (colon < 0) continue
    const name = normaliseThemeProperty(declaration.slice(0, colon))
    let value = declaration.slice(colon + 1).trim()
    if (/!\s*important\s*$/i.test(value)) {
      important = true
      value = value.replace(/!\s*important\s*$/i, '').trim()
    }
    if (
      name.startsWith('--') &&
      protectedCustomPropertyPrefixes.some((prefix) => name.startsWith(prefix))
    )
      drop(context, `${label} { ${name} }`, 'protected_selector')
    else if (name === 'content') drop(context, `${label} { content }`, 'content')
    else if (!isAllowedThemeProperty(name)) {
      // The allowlist (decision 102): a property that is not on it never reaches the page. The shared module is also
      // what the server's import check asks.
      drop(context, `${label} { ${name} }`, 'property_not_allowed')
    } else {
      const cleaned = cleanUrls(value, context)
      if (cleaned === null) drop(context, `${label} { ${name}: ${value} }`, 'external_url')
      else if (!checkThemeDeclaration(name, value).ok)
        drop(context, `${label} { ${name}: ${value} }`, 'value_not_allowed')
      else kept.push({ name, value: cleaned })
    }
  }
  return { kept, important }
}

type RuleLike = {
  constructor: { name: string }
  cssText: string
  cssRules?: ArrayLike<RuleLike>
  selectorText?: string
  style?: { cssText: string }
  name?: string
  keyText?: string
}

function head(rule: RuleLike): string {
  const text = rule.cssText
  const brace = text.indexOf('{')
  return (brace < 0 ? text : text.slice(0, brace)).trim()
}

function walkRules(rules: ArrayLike<RuleLike>, context: Context): string[] {
  const out: string[] = []
  for (let i = 0; i < rules.length; i++) {
    const rule = rules[i]
    if (!rule) continue
    const kind = rule.constructor.name
    const label = head(rule)
    if (kind === 'CSSImportRule') drop(context, label, 'import')
    else if (kind === 'CSSFontFaceRule') drop(context, label, 'font_face')
    else if (kind === 'CSSStyleRule' || (rule.selectorText !== undefined && rule.style)) {
      const selector = rule.selectorText ?? ''
      if (selectorReaches(selector)) {
        drop(context, selector, 'protected_selector')
        continue
      }
      // Highlight pseudo-elements and the other pseudo-elements off the shared list (decision 102, third gate finding 2).
      if (!checkThemeSelector(selector).ok) {
        drop(context, selector, 'selector_not_allowed')
        continue
      }
      const { kept, important } = cleanDeclarations(rule.style?.cssText ?? '', context, selector)
      if (important) {
        drop(context, selector, 'important')
        continue
      }
      const nested = rule.cssRules ? walkRules(rule.cssRules, context) : []
      if (kept.length === 0 && nested.length === 0) continue
      // `opacity` dims what is inside: it applies only where nothing protected is inside (see WITHOUT_PROTECTED_INSIDE).
      const guarded = (name: string) =>
        context.confine && THEME_CSS_NOT_ON_PROTECTED_ANCESTORS.includes(name)
      const text = (declarations: Kept[]) =>
        declarations.map(({ name, value }) => `${name}: ${value};`).join(' ')
      const body = text(kept.filter(({ name }) => !guarded(name)))
      const dimming = text(kept.filter(({ name }) => guarded(name)))
      const target = context.confine ? confineSelector(selector) : selector
      if (body || nested.length > 0)
        out.push(`${target} { ${[body, ...nested].filter(Boolean).join(' ')} }`)
      if (dimming) out.push(`${confineSelector(selector, WITHOUT_PROTECTED_INSIDE)} { ${dimming} }`)
    } else if (kind === 'CSSKeyframesRule') {
      drop(context, label, 'other_at_rule')
    } else if (GROUPING.has(kind) && rule.cssRules) {
      if (selectorReaches(label)) {
        drop(context, label, 'protected_selector')
        continue
      }
      const inner = walkRules(rule.cssRules, context)
      if (inner.length) out.push(`${label} { ${inner.join(' ')} }`)
    } else drop(context, label, 'other_at_rule')
  }
  return out
}

/**
 * Cleans theme CSS. With `themeId`, `asset:` references become the theme's own asset URLs; without it they stay
 * `asset:` (what is stored and exported).
 */
export function sanitiseCss(
  text: string,
  options: {
    themeId?: string
    resolve?: (ref: string) => string | null
    /** Keep every rule out of protected subtrees (what the engine applies); the stored text stays plain. */
    confine?: boolean
  } = {},
): SanitiseResult {
  const context: Context = {
    confine: options.confine ?? false,
    themeId: options.themeId ?? null,
    ...(options.resolve ? { resolve: options.resolve } : {}),
    report: [],
  }
  if (!text.trim()) return { css: '', report: { dropped: [] } }
  if (typeof CSSStyleSheet === 'undefined' || !('replaceSync' in CSSStyleSheet.prototype)) {
    return { css: '', report: { dropped: [{ rule: '(all CSS)', reason: 'other_at_rule' }] } }
  }
  let sheet: CSSStyleSheet
  try {
    sheet = new CSSStyleSheet()
    sheet.replaceSync(text)
  } catch {
    return { css: '', report: { dropped: [{ rule: '(all CSS)', reason: 'other_at_rule' }] } }
  }
  const css = walkRules(sheet.cssRules as unknown as ArrayLike<RuleLike>, context).join('\n')
  // Browsers ignore @import in a constructed sheet without telling anyone: say so in the report.
  if (/@\s*import/i.test(text) && !context.report.some((item) => item.reason === 'import'))
    drop(context, '@import', 'import')
  return { css, report: { dropped: context.report } }
}
