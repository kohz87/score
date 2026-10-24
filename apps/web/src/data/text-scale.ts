import { useSyncExternalStore } from 'react'

/** The bold shell's text size (Settings › Look): a per-device multiplier, 0.9 to 1.2. */
export const TEXT_SCALE_MIN = 0.9
export const TEXT_SCALE_MAX = 1.2
export const TEXT_SCALE_STEP = 0.05
const STORAGE_KEY = 'score.textScale'
export const TEXT_SCALE_CHANGED = 'score:text-scale-changed'

/** Snap to the range's step and keep the value inside its bounds. */
export function normalizeTextScale(value: number): number {
  if (!Number.isFinite(value)) return 1
  const stepped = Math.round(value / TEXT_SCALE_STEP) * TEXT_SCALE_STEP
  return Math.min(TEXT_SCALE_MAX, Math.max(TEXT_SCALE_MIN, Number(stepped.toFixed(2))))
}

export function readTextScale(): number {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    return raw === null ? 1 : normalizeTextScale(Number(raw))
  } catch {
    return 1
  }
}

export function saveTextScale(value: number): void {
  const scale = normalizeTextScale(value)
  try {
    if (scale === 1) window.localStorage.removeItem(STORAGE_KEY)
    else window.localStorage.setItem(STORAGE_KEY, String(scale))
  } catch {
    // Blocked storage still applies for this visit through the event below.
  }
  window.dispatchEvent(new Event(TEXT_SCALE_CHANGED))
}

function subscribe(onChange: () => void): () => void {
  window.addEventListener(TEXT_SCALE_CHANGED, onChange)
  window.addEventListener('storage', onChange)
  return () => {
    window.removeEventListener(TEXT_SCALE_CHANGED, onChange)
    window.removeEventListener('storage', onChange)
  }
}

export function useTextScale(): number {
  return useSyncExternalStore(subscribe, readTextScale, () => 1)
}
