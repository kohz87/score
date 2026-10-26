import { useCallback, useEffect, useRef, useState } from 'react'

/** Where the reader counts as "at the end", so new and growing messages keep being followed. */
const FOLLOW_SLACK = 80

/**
 * Keeps a scrolling message stream at its end: a room or job opened from another starts there, and new, growing or
 * highlighting messages follow a reader who is still at the end. Someone who scrolled up to read is left alone, and
 * `paused` (a link seeking to one message) leaves the scroll to that seek.
 * Returns the ref callback for the scrolling element.
 */
export function useFollowEnd(
  resetKey: string,
  paused: boolean,
): (element: HTMLElement | null) => void {
  // The element lives in a ref (it is scrolled, not rendered); the counter re-runs the effect when it mounts or changes.
  const holder = useRef<HTMLElement | null>(null)
  const [mounted, setMounted] = useState(0)
  const following = useRef(true)
  const shown = useRef(resetKey)

  useEffect(() => {
    const element = holder.current
    if (!element) return
    if (shown.current !== resetKey) {
      shown.current = resetKey
      following.current = true
    }
    // The scroll event arrives a frame after the scroll, but the observer below runs in a microtask: a reader who just
    // scrolled up while a reply streams would be snapped back. So the position is compared at every snap, and wheel,
    // touch and key input leave the end at once.
    let lastTop = element.scrollTop
    let lastHeight = element.scrollHeight
    // Up means the reader moved: a stream that got shorter also lowers scrollTop (the browser clamps it), and that
    // is not the reader leaving the end.
    const movedUp = () => element.scrollTop < lastTop - 1 && element.scrollHeight >= lastHeight
    const remember = () => {
      lastTop = element.scrollTop
      lastHeight = element.scrollHeight
    }
    const leave = () => {
      following.current = false
    }
    const toEnd = () => {
      if (movedUp()) following.current = false
      if (following.current && !paused) element.scrollTop = element.scrollHeight
      remember()
    }
    const onScroll = () => {
      if (movedUp()) following.current = false
      else
        following.current =
          element.scrollHeight - element.scrollTop - element.clientHeight < FOLLOW_SLACK
      remember()
    }
    const onWheel = (event: WheelEvent) => {
      if (event.deltaY < 0) leave()
    }
    const onKey = (event: KeyboardEvent) => {
      if (['ArrowUp', 'PageUp', 'Home'].includes(event.key)) leave()
    }
    toEnd()
    // Text streaming in, a code block highlighting, a card appearing: all are DOM changes under the stream.
    const mutations = new MutationObserver(toEnd)
    mutations.observe(element, { childList: true, subtree: true, characterData: true })
    // An image or an embedded preview that finishes loading grows its message without a DOM change.
    element.addEventListener('load', toEnd, true)
    element.addEventListener('scroll', onScroll, { passive: true })
    element.addEventListener('wheel', onWheel, { passive: true })
    element.addEventListener('touchmove', leave, { passive: true })
    element.addEventListener('keydown', onKey)
    return () => {
      mutations.disconnect()
      element.removeEventListener('load', toEnd, true)
      element.removeEventListener('scroll', onScroll)
      element.removeEventListener('wheel', onWheel)
      element.removeEventListener('touchmove', leave)
      element.removeEventListener('keydown', onKey)
    }
  }, [mounted, resetKey, paused])

  return useCallback((element: HTMLElement | null) => {
    if (holder.current === element) return
    holder.current = element
    setMounted((count) => count + 1)
  }, [])
}
