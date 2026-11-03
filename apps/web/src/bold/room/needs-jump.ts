export type JumpCard = { key: string; top: number; bottom: number }

export type Jump = {
  /** How many needs-you cards are entirely out of view. */
  count: number
  /** Which way the nearest one lies. */
  direction: 'up' | 'down'
  /** The nearest one: the chip scrolls to it and moves focus there. */
  key: string
}

/** 3.24.0: the cards that are out of view of the scrolling conversation, and the nearest of them. */
export function jumpTarget(view: { top: number; bottom: number }, cards: JumpCard[]): Jump | null {
  let nearest: { card: JumpCard; distance: number; direction: 'up' | 'down' } | null = null
  let count = 0
  for (const card of cards) {
    const above = card.bottom <= view.top
    const below = card.top >= view.bottom
    if (!above && !below) continue
    count += 1
    const distance = above ? view.top - card.bottom : card.top - view.bottom
    if (!nearest || distance < nearest.distance)
      nearest = { card, distance, direction: above ? 'up' : 'down' }
  }
  return nearest ? { count, direction: nearest.direction, key: nearest.card.key } : null
}
