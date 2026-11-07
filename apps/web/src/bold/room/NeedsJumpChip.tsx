import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react'
import { createPortal } from 'react-dom'
import { FOLLOW_SLACK } from './follow-end.ts'
import { goToCard, waitingCards } from './needs-jump-dom.ts'
import { CHIP_MIN_HEIGHT, chipClearance, jumpTarget, type Jump } from './needs-jump.ts'
import { slotIds, useNeedsSlotsOuter } from './needs-slots.tsx'

/**
 * 3.24.0: the chip above the composer that says a card needs you out of view and takes you to the nearest one.
 * It lives in the stream's `chip` slot (nothing is drawn where no conversation is, the cards are then in plain view).
 */
export function NeedsJumpChip({ cardKeys }: { cardKeys: string[] }) {
  const slots = useNeedsSlotsOuter()
  const slot = slots?.elements.get(slotIds.chip) ?? null
  const [jump, setJump] = useState<Jump | null>(null)
  const chipRef = useRef<HTMLButtonElement | null>(null)
  const clearance = useRef(chipClearance(CHIP_MIN_HEIGHT))
  const chipHeight = useRef(0)
  const measure = useCallback(() => {
    const scroller = document.getElementById('bold-room-stream')
    if (!scroller) return setJump(null)
    const view = scroller.getBoundingClientRect()
    const cards = waitingCards(scroller)
    const next = jumpTarget({ top: view.top, bottom: view.bottom }, cards, clearance.current)
    setJump((previous) =>
      previous?.key === next?.key &&
      previous?.count === next?.count &&
      previous?.direction === next?.direction
        ? previous
        : next,
    )
  }, [])
  useEffect(() => {
    const scroller = document.getElementById('bold-room-stream')
    if (!scroller) return
    const first = requestAnimationFrame(measure)
    scroller.addEventListener('scroll', measure, { passive: true })
    window.addEventListener('resize', measure)
    const observer = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measure)
    observer?.observe(scroller)
    const mutations =
      typeof MutationObserver === 'undefined' ? null : new MutationObserver(() => measure())
    mutations?.observe(scroller, { childList: true, subtree: true })
    return () => {
      cancelAnimationFrame(first)
      scroller.removeEventListener('scroll', measure)
      window.removeEventListener('resize', measure)
      observer?.disconnect()
      mutations?.disconnect()
    }
  }, [cardKeys.length, measure, slot])
  const showing = jump !== null && slot !== null
  // While any card waits, the stream keeps its bottom clear of the chip, so it never sits on a card's buttons. Keyed on
  // a card waiting, not on the chip showing: the padding moves the cards, so tying it to the chip made the two switch
  // each other on and off at the stream's end (3.24.0 review).
  const pending = cardKeys.length > 0 && slot !== null
  useLayoutEffect(() => {
    const scroller = document.getElementById('bold-room-stream')
    if (!scroller || !pending) return
    // The last measured height is kept while the chip is hidden, so a taller (wrapped) chip doesn't shrink the room
    // when it hides and grow it when it shows.
    const measured = chipRef.current?.getBoundingClientRect().height ?? 0
    if (measured > 0) chipHeight.current = measured
    const height = chipHeight.current
    const needed = chipClearance(height)
    if (needed !== clearance.current) {
      clearance.current = needed
      measure()
    }
    // The padding grows scrollHeight with no change inside the stream, so the follow-the-end logic never sees it:
    // a reader at the end is kept there here; one who scrolled up is left where they are.
    const atEnd = () =>
      scroller.scrollHeight - scroller.scrollTop - scroller.clientHeight < FOLLOW_SLACK
    const wasAtEnd = atEnd()
    scroller.style.paddingBottom = `${needed + 4}px`
    scroller.style.scrollPaddingBottom = `${needed}px`
    if (wasAtEnd) scroller.scrollTop = scroller.scrollHeight
    return () => {
      const stay = atEnd()
      scroller.style.paddingBottom = ''
      scroller.style.scrollPaddingBottom = ''
      if (stay) scroller.scrollTop = scroller.scrollHeight
    }
  }, [pending, showing, jump?.count, measure])
  if (!jump || !slot) return null
  const go = () => void goToCard(jump.key)
  const arrow = jump.direction === 'up' ? '↑' : '↓'
  return createPortal(
    <button
      ref={chipRef}
      type="button"
      className="bold-needs-jump"
      data-protected="inline-flex"
      aria-label={`${jump.count} ${jump.count === 1 ? 'card needs' : 'cards need'} you, ${jump.direction === 'up' ? 'above' : 'below'}. Go to the nearest.`}
      onClick={go}
    >
      {jump.count} {jump.count === 1 ? 'needs' : 'need'} you {arrow}
    </button>,
    slot,
  )
}
