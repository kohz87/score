import type { ThemeSanitiseReport } from '@score/contract'
import { ThemeAssetRefSchema, ThemeIdSchema } from '@score/contract'
import { protectedClasses, protectedCustomPropertyPrefixes } from './protected-surfaces.ts'

// The theme CSS sanitiser (design §4.1). The browser's own parser reads the text (escapes are resolved by it, so
// `\63 ontent` is `content`), every rule is checked, and only what passes is written back out. Anything the parser
// can't give us drops everything: a theme without CSS is a safe theme.

type Reason = ThemeSanitiseReport['dropped'][number]['reason']
export type SanitiseResult = { css: string; report: ThemeSanitiseReport }

const classPattern = new RegExp(`\\.(${protectedClasses.join('|')})(?![A-Za-z0-9_-])`, 'i')
const GROUPING = new Set([
  'CSSMediaRule',
  'CSSSupportsRule',
  'CSSLayerBlockRule',
  'CSSContainerRule',
])
const DANGEROUS_PROPERTIES = new Set(['-moz-binding', 'behavior', '-webkit-user-modify'])
const MAX_Z_INDEX = 50

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

type Context = { themeId: string | null; report: ThemeSanitiseReport['dropped'] }

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
    const name = declaration.slice(0, colon).trim().toLowerCase()
    let value = declaration.slice(colon + 1).trim()
    if (/!\s*important\s*$/i.test(value)) {
      important = true
      value = value.replace(/!\s*important\s*$/i, '').trim()
    }
    if (name === 'content') drop(context, `${label} { content }`, 'content')
    else if (name === 'position' && /^(fixed|sticky|-webkit-sticky)$/i.test(value))
      drop(context, `${label} { position: ${value} }`, 'fixed_position')
    else if (name === 'z-index' && !/^(auto|-?\d+)$/.test(value))
      drop(context, `${label} { z-index: ${value} }`, 'z_index')
    else if (name === 'z-index' && Number(value) > MAX_Z_INDEX)
      drop(context, `${label} { z-index: ${value} }`, 'z_index')
    else if (name === 'pointer-events' || DANGEROUS_PROPERTIES.has(name))
      drop(context, `${label} { ${name} }`, 'pointer_events')
    else if (
      name.startsWith('--') &&
      protectedCustomPropertyPrefixes.some((prefix) => name.startsWith(prefix))
    )
      drop(context, `${label} { ${name} }`, 'protected_selector')
    else {
      const cleaned = cleanUrls(value, context)
      if (cleaned === null) drop(context, `${label} { ${name}: ${value} }`, 'external_url')
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
      const { kept, important } = cleanDeclarations(rule.style?.cssText ?? '', context, selector)
      if (important) {
        drop(context, selector, 'important')
        continue
      }
      const nested = rule.cssRules ? walkRules(rule.cssRules, context) : []
      if (kept.length === 0 && nested.length === 0) continue
      const body = kept.map(({ name, value }) => `${name}: ${value};`).join(' ')
      out.push(`${selector} { ${[body, ...nested].filter(Boolean).join(' ')} }`)
    } else if (kind === 'CSSKeyframesRule') {
      const frames: string[] = []
      for (const frame of Array.from(rule.cssRules ?? [])) {
        const { kept, important } = cleanDeclarations(frame.style?.cssText ?? '', context, label)
        if (important) drop(context, label, 'important')
        else if (kept.length)
          frames.push(
            `${frame.keyText ?? ''} { ${kept.map(({ name, value }) => `${name}: ${value};`).join(' ')} }`,
          )
      }
      if (frames.length && !selectorReaches(String(rule.name ?? '')))
        out.push(`${label} { ${frames.join(' ')} }`)
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
export function sanitiseCss(text: string, options: { themeId?: string } = {}): SanitiseResult {
  const context: Context = { themeId: options.themeId ?? null, report: [] }
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
