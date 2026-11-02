import { useEffect, useRef, type KeyboardEvent, type PointerEvent, type RefObject } from 'react'
import type { BotInputEvent } from '@score/contract'
import { keyToKeysym } from './keysyms.ts'
import { click, rfbButtons, toScreenPoint, wheelNotch } from './pointer.ts'

const MOVE_EVERY_MS = 50
const HOLD_MS = 500
const DRAG_PX = 10
const SCROLL_PX = 40

/**
 * The picture of the desktop while this page holds control. It captures the keyboard only while focused and turns
 * pointer, wheel and touch gestures into screen input. Nothing here logs or stores what is typed or clicked.
 */
export function ScreenInput({
  boxRef,
  src,
  alt,
  width,
  height,
  label,
  push,
}: {
  boxRef: RefObject<HTMLDivElement | null>
  src: string
  alt: string
  width: number
  height: number
  label: string
  push: (...events: BotInputEvent[]) => void
}) {
  const imgRef = useRef<HTMLImageElement>(null)
  const lastMove = useRef(0)
  const held = useRef(0)
  const touch = useRef<{
    id: number
    x: number
    y: number
    startX: number
    startY: number
    scrolled: number
    dragging: boolean
    long: boolean
    timer: ReturnType<typeof setTimeout> | null
  } | null>(null)

  const point = (clientX: number, clientY: number) =>
    toScreenPoint(
      clientX,
      clientY,
      (imgRef.current ?? boxRef.current!).getBoundingClientRect(),
      width,
      height,
    )

  // A wheel listener must be non-passive to stop the page from scrolling under the screen.
  useEffect(() => {
    const box = boxRef.current
    if (!box) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      if (event.deltaY === 0) return
      const { x, y } = point(event.clientX, event.clientY)
      push(...wheelNotch(x, y, event.deltaY < 0, held.current))
    }
    box.addEventListener('wheel', onWheel, { passive: false })
    return () => box.removeEventListener('wheel', onWheel)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- point() only reads refs and the screen size
  }, [boxRef, push, width, height])

  useEffect(
    () => () => {
      if (touch.current?.timer) clearTimeout(touch.current.timer)
    },
    [],
  )

  function key(event: KeyboardEvent, down: boolean) {
    // The hidden phone keyboard input is not the screen; its own handlers deal with it.
    if (event.target !== event.currentTarget) return
    const keysym = keyToKeysym(event.key)
    if (keysym === null) return
    event.preventDefault()
    push({ k: 'key', keysym, down })
  }

  function down(event: PointerEvent<HTMLDivElement>) {
    boxRef.current?.focus()
    const { x, y } = point(event.clientX, event.clientY)
    if (event.pointerType === 'touch') {
      if (touch.current) return
      const state = {
        id: event.pointerId,
        x: event.clientX,
        y: event.clientY,
        startX: event.clientX,
        startY: event.clientY,
        scrolled: 0,
        dragging: false,
        long: false,
        timer: null as ReturnType<typeof setTimeout> | null,
      }
      state.timer = setTimeout(() => {
        if (state.dragging) return
        state.long = true
        push(...click(x, y, 4))
      }, HOLD_MS)
      touch.current = state
      event.currentTarget.setPointerCapture?.(event.pointerId)
      return
    }
    event.currentTarget.setPointerCapture?.(event.pointerId)
    held.current = rfbButtons(event.buttons)
    push({ k: 'pointer', x, y, buttons: held.current })
  }

  function move(event: PointerEvent<HTMLDivElement>) {
    if (event.pointerType === 'touch') {
      const state = touch.current
      if (!state || state.id !== event.pointerId) return
      if (
        !state.dragging &&
        !state.long &&
        Math.hypot(event.clientX - state.startX, event.clientY - state.startY) > DRAG_PX
      ) {
        state.dragging = true
        if (state.timer) clearTimeout(state.timer)
      }
      if (state.dragging) {
        const { x, y } = point(event.clientX, event.clientY)
        // Dragging the finger down scrolls the content up, like a wheel turned up.
        let delta = event.clientY - state.y
        while (Math.abs(delta) >= SCROLL_PX) {
          push(...wheelNotch(x, y, delta > 0))
          const step = delta > 0 ? SCROLL_PX : -SCROLL_PX
          delta -= step
          state.y += step
        }
      }
      return
    }
    const now = Date.now()
    if (held.current === 0 && now - lastMove.current < MOVE_EVERY_MS) return
    lastMove.current = now
    const { x, y } = point(event.clientX, event.clientY)
    push({ k: 'pointer', x, y, buttons: held.current })
  }

  function up(event: PointerEvent<HTMLDivElement>) {
    if (event.pointerType === 'touch') {
      const state = touch.current
      if (!state || state.id !== event.pointerId) return
      touch.current = null
      if (state.timer) clearTimeout(state.timer)
      if (event.type === 'pointerup' && !state.dragging && !state.long) {
        const { x, y } = point(event.clientX, event.clientY)
        push(...click(x, y, 1))
      }
      return
    }
    const { x, y } = point(event.clientX, event.clientY)
    held.current = rfbButtons(event.buttons)
    push({ k: 'pointer', x, y, buttons: held.current })
  }

  return (
    <div
      ref={boxRef}
      className="bold-to-screen"
      tabIndex={0}
      role="application"
      aria-label={label}
      onKeyDown={(event) => key(event, true)}
      onKeyUp={(event) => key(event, false)}
      onPointerDown={down}
      onPointerMove={move}
      onPointerUp={up}
      onPointerCancel={up}
      onContextMenu={(event) => event.preventDefault()}
    >
      <img
        ref={imgRef}
        className="bold-live-screen-img"
        src={src}
        alt={alt}
        width={width}
        height={height}
        style={{ aspectRatio: `${width} / ${height}` }}
        draggable={false}
      />
    </div>
  )
}
