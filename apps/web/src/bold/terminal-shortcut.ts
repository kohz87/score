/** True while the keyboard focus is somewhere text is typed, where a shell shortcut must stay out of the way. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

/**
 * Ctrl+` (Cmd+` on a Mac) opens the terminal or returns from it. The terminal's own xterm input is a textarea, so the
 * shortcut does not fire from inside the shell it controls; the Back button covers that.
 */
export function isTerminalShortcut(event: KeyboardEvent): boolean {
  if (event.key !== '`' || event.altKey || event.shiftKey) return false
  if (!(event.ctrlKey || event.metaKey)) return false
  return !isTypingTarget(event.target)
}
