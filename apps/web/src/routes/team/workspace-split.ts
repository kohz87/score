import { useCallback, useState, type KeyboardEvent, type PointerEvent, type RefObject } from 'react'

export const MIN_TREE = 200
export const MAX_TREE = 640
export const DEFAULT_TREE = 300
const STEP = 16
const STORAGE_KEY = 'score.workspace.treeWidth'

export const clampTree = (width: number) =>
  Math.min(MAX_TREE, Math.max(MIN_TREE, Math.round(width)))

function readStored(): number {
  try {
    const value = Number(window.localStorage.getItem(STORAGE_KEY))
    return Number.isFinite(value) && value > 0 ? clampTree(value) : DEFAULT_TREE
  } catch {
    return DEFAULT_TREE
  }
}
function store(width: number) {
  try {
    window.localStorage.setItem(STORAGE_KEY, String(width))
  } catch {
    // Private window or blocked storage: the width just isn't remembered.
  }
}

/** Width of the file-list column, set by dragging or by keys on the separator, remembered per browser. */
export function useTreeWidth(grid: RefObject<HTMLElement | null>) {
  const [width, setWidth] = useState(readStored)
  const commit = useCallback((next: number) => {
    const clean = clampTree(next)
    setWidth(clean)
    store(clean)
  }, [])
  const onPointerDown = (event: PointerEvent<HTMLElement>) => {
    event.preventDefault()
    event.currentTarget.setPointerCapture(event.pointerId)
  }
  const onPointerMove = (event: PointerEvent<HTMLElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
    const left = grid.current?.getBoundingClientRect().left ?? 0
    // The tree pane starts at the grid's left edge; the separator sits centred in the gap after it.
    setWidth(clampTree(event.clientX - left - 8))
  }
  const onPointerUp = (event: PointerEvent<HTMLElement>) => {
    if (!event.currentTarget.hasPointerCapture(event.pointerId)) return
    event.currentTarget.releasePointerCapture(event.pointerId)
    commit(width)
  }
  const onKeyDown = (event: KeyboardEvent<HTMLElement>) => {
    const next =
      event.key === 'ArrowLeft'
        ? width - STEP
        : event.key === 'ArrowRight'
          ? width + STEP
          : event.key === 'Home'
            ? MIN_TREE
            : event.key === 'End'
              ? MAX_TREE
              : null
    if (next === null) return
    event.preventDefault()
    commit(next)
  }
  return { width, handlers: { onPointerDown, onPointerMove, onPointerUp, onKeyDown } }
}
