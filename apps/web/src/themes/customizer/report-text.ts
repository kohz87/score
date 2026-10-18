import type { ThemeSanitiseReport } from '@score/contract'

type Reason = ThemeSanitiseReport['dropped'][number]['reason']

// What the sanitiser's reasons mean, in the words the Customizer and the import preview use.
const reasons: Record<Reason, string> = {
  import: '@import isn’t allowed in a theme.',
  external_url:
    'A web address in url() was removed. Only the theme’s own files (asset:…) can be used.',
  content: 'The content property was removed.',
  property_not_allowed:
    'This property isn’t on the list a theme may change (colours, backgrounds, borders, shadows, fonts and a few more), so it was removed. Layout comes from the Layout section.',
  value_not_allowed:
    'The property is allowed, but this value isn’t, so the declaration was removed.',
  important: 'A rule using !important was removed.',
  protected_selector:
    'A rule that reaches approvals, security screens or other protected parts was removed.',
  selector_not_allowed:
    'A rule on a pseudo-element a theme may not style (such as ::selection) was removed.',
  font_face: '@font-face rules were removed. Add fonts in the Fonts section instead.',
  other_at_rule: 'A rule Score doesn’t support in themes was removed.',
}

export type DroppedLine = { rule: string; why: string }

/** The property a dropped declaration named (`.a { word-spacing }` or `.a { color: url(x) }`), if the label has one. */
function propertyOf(rule: string): string | null {
  const match = /\{\s*(--[\w-]+|[a-z-]+)\s*(?::[^}]*)?\}\s*$/i.exec(rule)
  return match ? match[1]! : null
}

export function describeDropped(report: ThemeSanitiseReport): DroppedLine[] {
  return report.dropped.map((item) => {
    const property = item.reason === 'property_not_allowed' ? propertyOf(item.rule) : null
    return {
      rule: item.rule,
      why: property ? `\`${property}\`: ${reasons[item.reason]}` : reasons[item.reason],
    }
  })
}

export function reportSummary(report: ThemeSanitiseReport): string {
  const n = report.dropped.length
  return n === 0
    ? 'Nothing was removed.'
    : n === 1
      ? '1 rule was removed.'
      : `${n} rules were removed.`
}
