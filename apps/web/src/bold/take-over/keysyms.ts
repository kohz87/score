// Browser key names to X11 keysyms for the take-over screen (3.17.0). Pure, so it is tested without a DOM.

const NAMED: Record<string, number> = {
  Enter: 0xff0d,
  Backspace: 0xff08,
  Tab: 0xff09,
  Escape: 0xff1b,
  Delete: 0xffff,
  Insert: 0xff63,
  Home: 0xff50,
  End: 0xff57,
  PageUp: 0xff55,
  PageDown: 0xff56,
  ArrowLeft: 0xff51,
  ArrowUp: 0xff52,
  ArrowRight: 0xff53,
  ArrowDown: 0xff54,
  Shift: 0xffe1,
  Control: 0xffe3,
  Alt: 0xffe9,
  Meta: 0xffeb,
  CapsLock: 0xffe5,
  ContextMenu: 0xff67,
}
for (let n = 1; n <= 12; n++) NAMED[`F${n}`] = 0xffbd + n

/** The keysym for a `KeyboardEvent.key`, or null for a key Score doesn't send. */
export function keyToKeysym(key: string): number | null {
  const named = NAMED[key]
  if (named !== undefined) return named
  const points = [...key]
  if (points.length !== 1) return null
  return charToKeysym(points[0]!)
}

/** The keysym for one typed character (Latin-1 as itself, anything else as a Unicode keysym). */
export function charToKeysym(char: string): number | null {
  const point = char.codePointAt(0)
  if (point === undefined) return null
  if ((point >= 0x20 && point <= 0x7e) || (point >= 0xa0 && point <= 0xff)) return point
  if (point < 0x20 || (point >= 0x7f && point < 0xa0)) return null
  return 0x01000000 + point
}

export type KeyEvent = { k: 'key'; keysym: number; down: boolean }

/** A key pressed and released. */
export function press(keysym: number): KeyEvent[] {
  return [
    { k: 'key', keysym, down: true },
    { k: 'key', keysym, down: false },
  ]
}

/** Modifiers down, the key, modifiers up in reverse. */
function chord(modifiers: number[], keysym: number): KeyEvent[] {
  return [
    ...modifiers.map((m): KeyEvent => ({ k: 'key', keysym: m, down: true })),
    ...press(keysym),
    ...[...modifiers].reverse().map((m): KeyEvent => ({ k: 'key', keysym: m, down: false })),
  ]
}

const CTRL = NAMED.Control!
const ALT = NAMED.Alt!

/** The Ctrl+Alt+… menu: what a keyboard-less phone (or a captured browser shortcut) can't type. */
export const SHORTCUTS: { label: string; events: KeyEvent[] }[] = [
  { label: 'Ctrl+C', events: chord([CTRL], 0x63) },
  { label: 'Ctrl+V', events: chord([CTRL], 0x76) },
  { label: 'Ctrl+L', events: chord([CTRL], 0x6c) },
  { label: 'Ctrl+A', events: chord([CTRL], 0x61) },
  { label: 'Alt+Tab', events: chord([ALT], NAMED.Tab!) },
  { label: 'Esc', events: press(NAMED.Escape!) },
  { label: 'Enter', events: press(NAMED.Enter!) },
]

/** Typed text as key presses (Enter and Tab for line breaks and tabs); characters without a keysym are skipped. */
export function textToEvents(text: string): KeyEvent[] {
  const events: KeyEvent[] = []
  for (const char of text) {
    const keysym = char === '\n' ? NAMED.Enter! : char === '\t' ? NAMED.Tab! : charToKeysym(char)
    if (keysym !== null) events.push(...press(keysym))
  }
  return events
}
