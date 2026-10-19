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
