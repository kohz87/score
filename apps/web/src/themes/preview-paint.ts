import type { ThemeManifest } from '@score/contract'
import {
  LOOK_ATTRIBUTES,
  loadBuiltinFonts,
  lookParts,
  type AssetResolver,
  type ColorMode,
} from './engine.ts'
import { resolveLayout, type LayoutConfig, type LookView } from './layout.ts'
import { sanitiseCss } from './sanitise.ts'
import type { ThemeSanitiseReport } from '@score/contract'

// The Customizer's draft is painted into the document of its preview frame and nowhere else (PLAN 9.4): no adopted
// sheet on the page, no attribute on the page's <html>, no boot cache, no `look.changed`. The same functions as the
// real engine decide what the look is (lookParts, sanitiseCss); only the place they write to differs.

export type PreviewInput = {
  manifest: ThemeManifest
  /** The theme's CSS as typed; it is sanitised here exactly as an installed theme's is. */
  css: string
  themeId: string
  mode: ColorMode
  view: LookView
  resolve: AssetResolver
}
export type PreviewResult = {
  report: ThemeSanitiseReport
  layout: LayoutConfig
  contrastFallback: boolean
}

const STYLE_MARK = 'data-preview-look'
const OWN_ATTRIBUTES = [
  ...LOOK_ATTRIBUTES,
  'data-pack',
  'data-layout',
  'data-density',
  'data-theme',
]

export function paintPreview(doc: Document, input: PreviewInput): PreviewResult {
  const parts = lookParts(input.manifest, input.themeId, input.mode, input.view, input.resolve)
  const { css, report } = sanitiseCss(input.css, {
    themeId: input.themeId,
    resolve: input.resolve,
  })
  const root = doc.documentElement
  for (const name of OWN_ATTRIBUTES) root.removeAttribute(name)
  for (const [name, value] of Object.entries(parts.attributes)) root.setAttribute(name, value)
  root.setAttribute('data-theme', input.mode)
  doc.head.querySelectorAll(`style[${STYLE_MARK}]`).forEach((element) => element.remove())
  for (const text of [parts.css, css]) {
    if (!text) continue
    const element = doc.createElement('style')
    element.setAttribute(STYLE_MARK, '')
    element.textContent = text
    doc.head.append(element)
  }
  loadBuiltinFonts(parts.look)
  return { report, layout: resolveLayout(parts.look), contrastFallback: parts.contrastFallback }
}
