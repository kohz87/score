import type { ThemeSanitiseReport } from '@score/contract'

type Reason = ThemeSanitiseReport['dropped'][number]['reason']

// What the sanitiser's reasons mean, in the words the Customizer and the import preview use.
const reasons: Record<Reason, string> = {
  import: '@import isn’t allowed in a theme.',
  external_url:
    'A web address in url() was removed. Only the theme’s own files (asset:…) can be used.',
  content: 'The content property was removed.',
  fixed_position: 'position: fixed and sticky were removed.',
  z_index: 'A z-index above 50 was removed.',
  pointer_events: 'A property that changes how the page reacts to clicks or typing was removed.',
  important: 'A rule using !important was removed.',
  protected_selector:
    'A rule that reaches approvals, security screens or other protected parts was removed.',
  font_face: '@font-face rules were removed. Add fonts in the Fonts section instead.',
  other_at_rule: 'A rule Score doesn’t support in themes was removed.',
}

export type DroppedLine = { rule: string; why: string }

export function describeDropped(report: ThemeSanitiseReport): DroppedLine[] {
  return report.dropped.map((item) => ({ rule: item.rule, why: reasons[item.reason] }))
}

export function reportSummary(report: ThemeSanitiseReport): string {
  const n = report.dropped.length
  return n === 0
    ? 'Nothing was removed.'
    : n === 1
      ? '1 rule was removed.'
      : `${n} rules were removed.`
}
