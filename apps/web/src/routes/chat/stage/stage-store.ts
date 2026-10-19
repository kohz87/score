import { useSyncExternalStore } from 'react'

// Whether this device shows the room stage (PLAN 10.10). A per-device convenience like the colour mode: shown unless
// hidden here; storage that is blocked still works for the visit.
const STORAGE_KEY = 'score.roomStage'
/** Fired on window when the choice changes, so every stage and toggle on the page follows at once. */
export const STAGE_CHANGED = 'score:room-stage-changed'

// What this visit chose when storage could not keep it.
let visit: boolean | null = null

export function readStageShown(): boolean {
  if (visit !== null) return visit
  try {
    return window.localStorage.getItem(STORAGE_KEY) !== 'hidden'
  } catch {
    return true
  }
}

export function saveStageShown(shown: boolean): void {
  visit = shown
  try {
    if (shown) window.localStorage.removeItem(STORAGE_KEY)
    else window.localStorage.setItem(STORAGE_KEY, 'hidden')
  } catch {
    // The visit's own copy above still applies.
  }
  window.dispatchEvent(new Event(STAGE_CHANGED))
}

function subscribe(onChange: () => void): () => void {
  const changed = () => {
    // Another tab wrote the key: its value is the truth again.
    visit = null
    onChange()
  }
  window.addEventListener(STAGE_CHANGED, onChange)
  window.addEventListener('storage', changed)
  return () => {
    window.removeEventListener(STAGE_CHANGED, onChange)
    window.removeEventListener('storage', changed)
  }
}

export function useStageShown(): boolean {
  return useSyncExternalStore(subscribe, readStageShown, () => true)
}
