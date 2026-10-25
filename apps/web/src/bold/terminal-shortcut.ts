/** True while the keyboard focus is somewhere text is typed, where a shell shortcut must stay out of the way. */
export function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

/** xterm's hidden input: typing in the shell itself, where Ctrl+` still means "back out of the terminal". */
function isTerminalInput(target: EventTarget | null): boolean {
  return target instanceof HTMLElement && target.classList.contains('xterm-helper-textarea')
}

/**
 * Ctrl+` (Cmd+` on a Mac) opens the terminal or returns from it, also from inside the shell (a shell has no use for
 * it). Held keys and IME composition never toggle it; other text fields keep the keystroke.
 */
export function isTerminalShortcut(event: KeyboardEvent): boolean {
  if (event.repeat || event.isComposing) return false
  if (event.key !== '`' || event.altKey || event.shiftKey) return false
  if (!(event.ctrlKey || event.metaKey)) return false
  return isTerminalInput(event.target) || !isTypingTarget(event.target)
}
