import { ratioText } from '../../themes/customizer/checks.ts'
import type { TextFinding } from '../../themes/customizer/measure.ts'

/** A piece of text in the preview that is hard to read, in words. */
export function textFindingWords(finding: TextFinding, page: string): string {
  return `“${finding.text}” on the ${page} page is hard to read over its background (${ratioText(finding.ratio)}; ${finding.minimum}:1 is the least that works). Dim the picture, or choose a text colour with more contrast.`
}
