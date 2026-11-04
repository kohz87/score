import { jumpTarget, type JumpCard } from './needs-jump.ts'

/** The needs-you cards in the conversation that take up room (a card with no box is neither counted nor reachable). */
export function waitingCards(scroller: Element | null): JumpCard[] {
  if (!scroller) return []
  return [...scroller.querySelectorAll<HTMLElement>('[data-pin-key]')].flatMap((card) => {
    const rect = card.getBoundingClientRect()
    if (rect.height === 0) return []
    return [{ key: card.getAttribute('data-pin-key') ?? '', top: rect.top, bottom: rect.bottom }]
  })
}

/** Scrolls to a needs-you card and moves focus onto it (the jump chip's action). */
export function goToCard(key: string): boolean {
  const card = document.querySelector<HTMLElement>(`[data-pin-key=${JSON.stringify(key)}]`)
  if (!card) return false
  card.scrollIntoView?.({ block: 'center', behavior: 'smooth' })
  card.focus({ preventScroll: true })
  return true
}

/** The nearest waiting card to the conversation's view (the first when all are in view), for the viewer's cue. */
export function goToNearestCard(): boolean {
  const scroller = document.getElementById('bold-room-stream')
  const cards = waitingCards(scroller)
  const first = cards[0]
  if (!scroller || !first) return false
  const rect = scroller.getBoundingClientRect()
  const jump = jumpTarget({ top: rect.top, bottom: rect.bottom }, cards)
  return goToCard(jump?.key ?? first.key)
}
