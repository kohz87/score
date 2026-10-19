/** Bytes the phone key bar sends (the on-screen keyboard has no Esc, Tab, Ctrl or arrows). */
export const KEY_BYTES = {
  Esc: '\x1b',
  Tab: '\t',
  Up: '\x1b[A',
  Down: '\x1b[B',
  Right: '\x1b[C',
  Left: '\x1b[D',
} as const

/** Ctrl + a letter is that letter's control code (Ctrl+C = 0x03); anything else passes through unchanged. */
export function withCtrl(data: string): string {
  if (data.length !== 1) return data
  const code = data.toUpperCase().charCodeAt(0)
  return code >= 64 && code <= 95 ? String.fromCharCode(code - 64) : data
}

/**
 * What a key does to the clipboard in the terminal, the Windows Terminal way: Ctrl+C copies when text is selected (and
 * is the interrupt otherwise), Ctrl+V and Ctrl+Shift+V paste. ⌘C/⌘V on a Mac already reach the browser untouched.
 */
export function clipboardKey(
  event: Pick<KeyboardEvent, 'key' | 'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey'>,
  hasSelection: boolean,
): 'copy' | 'paste' | null {
  if (!event.ctrlKey || event.altKey || event.metaKey) return null
  const key = event.key.toLowerCase()
  if (key === 'c') return hasSelection ? 'copy' : null
  if (key === 'v') return 'paste'
  return null
}

/** The most a program may put on the clipboard in one go (a tmux selection is far smaller). */
export const OSC52_MAX_BYTES = 256 * 1024

/**
 * The text of an OSC 52 "set clipboard" sequence (`Pc;Pd`: targets, then base64), as tmux sends when you select with
 * the mouse. Null for a query (`?`, a program asking to read the clipboard: never answered), malformed base64, text
 * that isn't UTF-8, or anything over the cap.
 */
export function osc52Text(data: string): string | null {
  const semi = data.indexOf(';')
  if (semi < 0) return null
  const targets = data.slice(0, semi)
  const payload = data.slice(semi + 1)
  if (!/^[cps0-7]*$/.test(targets) || payload === '?' || payload === '') return null
  if (
    !/^[A-Za-z0-9+/]+={0,2}$/.test(payload) ||
    payload.length > Math.ceil((OSC52_MAX_BYTES * 4) / 3) + 4
  )
    return null
  let bytes: Uint8Array
  try {
    bytes = Uint8Array.from(atob(payload), (c) => c.charCodeAt(0))
  } catch {
    return null
  }
  if (bytes.length > OSC52_MAX_BYTES) return null
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes)
  } catch {
    return null
  }
}
