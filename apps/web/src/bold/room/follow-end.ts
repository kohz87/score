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
    const toEnd = () => {
      if (following.current && !paused) element.scrollTop = element.scrollHeight
    }
    const onScroll = () => {
      following.current =
        element.scrollHeight - element.scrollTop - element.clientHeight < FOLLOW_SLACK
    }
    toEnd()
    // Text streaming in, a code block highlighting, a card appearing: all are DOM changes under the stream.
    const mutations = new MutationObserver(toEnd)
    mutations.observe(element, { childList: true, subtree: true, characterData: true })
    // An image or an embedded preview that finishes loading grows its message without a DOM change.
    element.addEventListener('load', toEnd, true)
    element.addEventListener('scroll', onScroll, { passive: true })
    return () => {
      mutations.disconnect()
      element.removeEventListener('load', toEnd, true)
      element.removeEventListener('scroll', onScroll)
    }
  }, [mounted, resetKey, paused])

  return useCallback((element: HTMLElement | null) => {
    if (holder.current === element) return
    holder.current = element
    setMounted((count) => count + 1)
  }, [])
}
