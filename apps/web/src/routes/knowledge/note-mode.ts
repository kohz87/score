import { useEffect, useState } from 'react'

export type NoteMode = 'preview' | 'edit' | 'split'

const KEY = 'score.knowledge.mode'
const WIDE = '(min-width: 1200px)'

/** The person's last view of a note on this device; notes open rendered when nothing is remembered. */
export function readMode(): NoteMode {
  try {
    const stored = localStorage.getItem(KEY)
    if (stored === 'edit' || stored === 'split' || stored === 'preview') return stored
  } catch {
    // Storage can be blocked; the default applies.
  }
  return 'preview'
}

export function writeMode(mode: NoteMode): void {
  try {
    localStorage.setItem(KEY, mode)
  } catch {
    // Not remembered; nothing else depends on it.
  }
}

/** Split needs room for two panes. */
export function useWide(): boolean {
  const query = () => (typeof matchMedia === 'function' ? matchMedia(WIDE) : null)
  const [wide, setWide] = useState(() => query()?.matches ?? false)
  useEffect(() => {
    const list = query()
    if (!list) return
    const update = () => setWide(list.matches)
    update()
    list.addEventListener('change', update)
    return () => list.removeEventListener('change', update)
  }, [])
  return wide
}
