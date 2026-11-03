export type JumpCard = { key: string; top: number; bottom: number }

export type Jump = {
  /** How many needs-you cards are entirely out of view. */
  count: number
  /** Which way the nearest one lies. */
  direction: 'up' | 'down'
  /** The nearest one: the chip scrolls to it and moves focus there. */
  key: string
}

/** The chip floats this far above the stream's bottom edge (bold-room.css: translateY(-100% - 8px)). */
const CHIP_OFFSET = 8
/** Air kept between the chip and the card (or button) behind it. */
const CHIP_GAP = 8
/** The chip's CSS min-height, used until the real chip has been measured. */
export const CHIP_MIN_HEIGHT = 36

/** How much of the stream's bottom the floating chip covers: its height, its lift and a gap. */
export function chipClearance(chipHeight: number): number {
  return Math.max(chipHeight, CHIP_MIN_HEIGHT) + CHIP_OFFSET + CHIP_GAP
}

/**
 * 3.24.0: the cards that are out of view of the scrolling conversation, and the nearest of them. `clearance` is the
 * strip at the bottom of the view that the chip covers: a card counts as in view only when its bottom is above it
 * (so the chip never sits on a card's buttons); otherwise it counts as below.
 */
export function jumpTarget(
  view: { top: number; bottom: number },
  cards: JumpCard[],
  clearance = 0,
): Jump | null {
  const limit = view.bottom - clearance
  let nearest: { card: JumpCard; distance: number; direction: 'up' | 'down' } | null = null
  let count = 0
  for (const card of cards) {
    const above = card.bottom <= view.top
    const below = card.top >= view.bottom || card.bottom > limit
    if (!above && !below) continue
    count += 1
    const distance = above ? view.top - card.bottom : Math.max(0, card.top - limit)
    if (!nearest || distance < nearest.distance)
      nearest = { card, distance, direction: above ? 'up' : 'down' }
  }
  return nearest ? { count, direction: nearest.direction, key: nearest.card.key } : null
}
