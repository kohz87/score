import { useCallback, useRef, useState } from 'react'

// Undo and redo for a draft. Typing coalesces: edits with the same key within a second make one step, so a sentence
// is one undo, not one per letter.

const COALESCE_MS = 1000
const LIMIT = 100

interface State<T> {
  past: T[]
  present: T
  future: T[]
}

export function useDraftHistory<T>(initial: T) {
  const [state, setState] = useState<State<T>>({ past: [], present: initial, future: [] })
  const last = useRef<{ key: string; at: number } | null>(null)

  const commit = useCallback((next: T, coalesce?: string) => {
    const now = Date.now()
    const merge =
      coalesce !== undefined &&
      last.current?.key === coalesce &&
      now - last.current.at < COALESCE_MS
    last.current = coalesce === undefined ? null : { key: coalesce, at: now }
    setState((current) =>
      merge
        ? { ...current, present: next, future: [] }
        : { past: [...current.past, current.present].slice(-LIMIT), present: next, future: [] },
    )
  }, [])
  const undo = useCallback(() => {
    last.current = null
    setState((current) => {
      const previous = current.past.at(-1)
      return previous === undefined
        ? current
        : {
            past: current.past.slice(0, -1),
            present: previous,
            future: [current.present, ...current.future],
          }
    })
  }, [])
  const redo = useCallback(() => {
    last.current = null
    setState((current) => {
      const [next, ...rest] = current.future
      return next === undefined
        ? current
        : { past: [...current.past, current.present], present: next, future: rest }
    })
  }, [])
  /** Replace the draft and forget the history (loading a version). */
  const reset = useCallback((next: T) => {
    last.current = null
    setState({ past: [], present: next, future: [] })
  }, [])

  return {
    draft: state.present,
    commit,
    undo,
    redo,
    reset,
    canUndo: state.past.length > 0,
    canRedo: state.future.length > 0,
  }
}
