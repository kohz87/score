import type { Message } from '@score/contract'
import {
  cloneElement,
  isValidElement,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
  type TouchEvent,
} from 'react'
import {
  clearPickedVersion,
  groupKey,
  onReplyVersionPicked,
  readPickedVersion,
  swipeBlockedBy,
  swipeStep,
  writePickedVersion,
} from './reply-versions.ts'

/** What a message of a group needs to draw: the pager and the memory note, and whether a new version is coming. */
export type ReplyGroupParts = {
  pager: ReactNode
  note: ReactNode
  /** Some version is still being written: Try another waits. */
  writing: boolean
}

/** The prototype's `‹ 2 / 3 ›` (`.vers`). Real buttons; the position is announced when it changes. */
export function ReplyPager({
  position,
  count,
  onStep,
}: {
  position: number
  count: number
  onStep: (step: -1 | 1) => void
}) {
  const first = position <= 1
  const last = position >= count
  function onKeyDown(event: KeyboardEvent<HTMLDivElement>) {
    if (event.key === 'ArrowLeft' && !first) {
      event.preventDefault()
      onStep(-1)
    } else if (event.key === 'ArrowRight' && !last) {
      event.preventDefault()
      onStep(1)
    }
  }
  return (
    <div
      className="bold-vers"
      role="group"
      aria-label="Versions of this reply"
      onKeyDown={onKeyDown}
    >
      <button
        type="button"
        aria-label="Previous version"
        aria-disabled={first}
        onClick={() => !first && onStep(-1)}
      >
        ‹
      </button>
      <span aria-hidden="true">
        {position} / {count}
      </span>
      <span className="bold-sr-only" role="status" aria-live="polite">
        Version {position} of {count}
      </span>
      <button
        type="button"
        aria-label="Next version"
        aria-disabled={last}
        onClick={() => !last && onStep(1)}
      >
        ›
      </button>
    </div>
  )
}

/**
 * Draws a group of replies as one message. The viewer's selection is component state (remembered per group); the
 * newest version is selected at first and whenever a newer one arrives, so the group follows a version as it streams.
 */
export function ReplyGroup({
  group,
  agentName,
  render,
}: {
  /** Members, oldest first, at least two. */
  group: Message[]
  agentName: string
  render: (message: Message, parts: ReplyGroupParts) => ReactNode
}) {
  const key = groupKey(group[0]!)
  const newest = group.at(-1)!.id
  const [picked, setPicked] = useState<string | null>(() => {
    const saved = readPickedVersion(key)
    return saved && group.some((member) => member.id === saved) ? saved : null
  })
  const [seenNewest, setSeenNewest] = useState(newest)
  if (seenNewest !== newest) {
    // A newer version arrived (Try another, Retry): show it.
    setSeenNewest(newest)
    setPicked(null)
  }
  // A newer version replaces any explicit pick, so a reload shows the newest.
  const lastNewest = useRef(newest)
  useEffect(() => {
    if (lastNewest.current === newest) return
    lastNewest.current = newest
    clearPickedVersion(key)
  }, [key, newest])
  useEffect(
    () =>
      onReplyVersionPicked((pickedKey, id) => {
        if (pickedKey === key) setPicked(id)
      }),
    [key],
  )
  const index = Math.max(
    0,
    group.findIndex((member) => member.id === (picked ?? newest)),
  )
  const shown = group[index]!
  function go(step: -1 | 1) {
    const next = group[index + step]
    if (!next) return
    setPicked(next.id)
    writePickedVersion(key, next.id)
  }
  const start = useRef<{ x: number; y: number } | null>(null)
  function onTouchStart(event: TouchEvent<HTMLDivElement>) {
    const touch = event.touches[0]
    start.current =
      event.touches.length === 1 && touch && !swipeBlockedBy(event.target, event.currentTarget)
        ? { x: touch.clientX, y: touch.clientY }
        : null
  }
  function onTouchEnd(event: TouchEvent<HTMLDivElement>) {
    const from = start.current
    start.current = null
    const touch = event.changedTouches[0]
    if (!from || !touch) return
    // A text selection is the person's own gesture, not a version swipe.
    const selection = window.getSelection?.()
    if (
      selection &&
      !selection.isCollapsed &&
      (event.currentTarget.contains(selection.anchorNode) ||
        event.currentTarget.contains(selection.focusNode))
    )
      return
    const step = swipeStep(touch.clientX - from.x, touch.clientY - from.y)
    if (step !== 0) go(step)
  }
  const parts: ReplyGroupParts = {
    pager: <ReplyPager position={index + 1} count={group.length} onStep={go} />,
    note: <p className="bold-vers-note">{agentName} remembers its earlier answers</p>,
    writing: group.some((member) => member.streaming),
  }
  return (
    <div
      className="bold-reply-group"
      data-reply-group={key}
      onTouchStart={onTouchStart}
      onTouchEnd={onTouchEnd}
    >
      {keepMounted(render(shown, parts))}
    </div>
  )
}

/** The shown version changes but the message stays mounted, so the pager keeps focus and announces the new position. */
function keepMounted(node: ReactNode): ReactNode {
  return isValidElement(node) ? cloneElement(node, { key: 'shown' }) : node
}
