import { expect, test } from 'vitest'
import { isTerminalShortcut } from './terminal-shortcut.ts'

function press(target: Element, init: KeyboardEventInit = {}): boolean {
  let result = false
  const handler = (event: Event) => {
    result = isTerminalShortcut(event as KeyboardEvent)
  }
  document.addEventListener('keydown', handler)
  target.dispatchEvent(new KeyboardEvent('keydown', { key: '`', bubbles: true, ...init }))
  document.removeEventListener('keydown', handler)
  return result
}

test('Ctrl+` and Cmd+` count, a bare backtick does not', () => {
  expect(press(document.body, { ctrlKey: true })).toBe(true)
  expect(press(document.body, { metaKey: true })).toBe(true)
  expect(press(document.body)).toBe(false)
})

test('is ignored while typing in an input, textarea or editable element', () => {
  for (const tag of ['input', 'textarea']) {
    const field = document.body.appendChild(document.createElement(tag))
    expect(press(field, { ctrlKey: true })).toBe(false)
    field.remove()
  }
  const editable = document.body.appendChild(document.createElement('div'))
  editable.contentEditable = 'true'
  // jsdom does not implement isContentEditable; mirror the browser.
  Object.defineProperty(editable, 'isContentEditable', { value: true })
  expect(press(editable, { ctrlKey: true })).toBe(false)
  editable.remove()
})
