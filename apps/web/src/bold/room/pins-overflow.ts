export type PinBox = { top: number; bottom: number }

/** What a scrolling pinned box hides below its visible edge: the cards not fully in view and where to scroll next. */
export function cardsBelow(
  view: { scrollTop: number; clientHeight: number },
  cards: PinBox[],
): { count: number; scrollTo: number } | null {
  const edge = view.scrollTop + view.clientHeight
  const hidden = cards.filter((card) => card.bottom > edge + 1)
  const next = hidden[0]
  if (!next) return null
  // A card that starts below the top is brought to the top; one already cut off at the bottom is scrolled to its end.
  return {
    count: hidden.length,
    scrollTo: next.top > view.scrollTop + 1 ? next.top : next.bottom - view.clientHeight,
  }
}
