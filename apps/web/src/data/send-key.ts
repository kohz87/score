export type SendKey = 'enter' | 'ctrl-enter'
const STORAGE_KEY = 'score.sendKey'

export function readSendKey(): SendKey {
  try {
    return window.localStorage.getItem(STORAGE_KEY) === 'ctrl-enter' ? 'ctrl-enter' : 'enter'
  } catch {
    return 'enter'
  }
}

export function saveSendKey(choice: SendKey): void {
  try {
    if (choice === 'enter') window.localStorage.removeItem(STORAGE_KEY)
    else window.localStorage.setItem(STORAGE_KEY, choice)
  } catch {
    // Blocked storage still applies for this visit only.
  }
}

/** A phone or tablet: no hover, a coarse pointer. There Enter is a newline key and the Send button sends. */
export function isTouchDevice(): boolean {
  try {
    return window.matchMedia('(hover: none) and (pointer: coarse)').matches
  } catch {
    return false
  }
}

/**
 * Whether this key press sends the message (otherwise the key behaves normally: Enter adds a newline).
 * Touch devices never send on a bare Enter; on desktop the setting decides, and Shift+Enter is always a newline.
 */
export function sendsOnKey(
  event: { key: string; shiftKey: boolean; ctrlKey: boolean; metaKey: boolean },
  mode: SendKey = readSendKey(),
  touch: boolean = isTouchDevice(),
): boolean {
  if (event.key !== 'Enter' || event.shiftKey) return false
  const modified = event.ctrlKey || event.metaKey
  if (modified) return true
  return !touch && mode === 'enter'
}
