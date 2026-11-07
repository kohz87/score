import type { Snapshot } from './guard-snapshot.ts'

/**
 * What a theme did to a text's contrast, or null. AA is the bar (4.5:1, 3:1 for large text) wherever the theme made
 * it worse than Score's own; a colour that can't be measured is a failure too, never a pass (gate finding #4).
 */
export function contrastVerdict(
  on: number | null,
  off: number | null,
  large: boolean,
  graphic = false,
): string | null {
  const needed = large ? 3 : 4.5
  if (on === null)
    return off === null
      ? null
      : graphic
        ? 'has a background whose colours can’t be checked'
        : 'has text whose colours can’t be checked'
  if (on >= needed) return null
  if (off === null || on < off - 0.05)
    return graphic ? 'can’t be told apart from its background' : 'has unreadable text'
  return null
}

/**
 * `context` is a decision's own fields and labels (third gate, finding 1): they are not protected surfaces, so a theme
 * may set their size, weight and a system font, but not hide, fade, cut, cover or blank them. A font the theme ships is
 * judged there too (fourth gate, finding 1: blank or substituted glyphs erase a field while its box and contrast stay
 * normal); the decision reads in Score's fonts (protected.css), so only a theme rule aimed at a field puts one back.
 */
export function worse(on: Snapshot, off: Snapshot, context = false): string | null {
  if (off.rendered && !on.rendered) return 'is not shown'
  if (!off.rendered) return null
  if (on.chainOpacity < off.chainOpacity - 0.02) return 'is faded'
  if (on.chainFilter && !off.chainFilter) return 'is filtered'
  if (on.chainClip && !off.chainClip) return 'is clipped'
  if (off.size > 0 && on.size < off.size * 0.5) return 'is shrunk'
  if (off.onScreen && !on.onScreen) return 'is pushed off screen'
  if (off.visible > 0.5 && on.visible < off.visible * 0.5) return 'is clipped'
  if (on.covered && !off.covered) return 'is covered'
  if (on.themeFont && !off.themeFont) return 'is set in the theme’s font'
  if (!context && off.fontSize > 0 && on.fontSize < off.fontSize * 0.5) return 'has tiny text'
  return contrastVerdict(on.contrast, off.contrast, on.large, on.graphic)
}
