import { expect, test } from 'vitest'
import { KEY_BYTES, clipboardKey, withCtrl } from './keys.ts'

test('Ctrl turns a letter into its control code', () => {
  expect(withCtrl('c')).toBe('\x03')
  expect(withCtrl('D')).toBe('\x04')
  expect(withCtrl('[')).toBe('\x1b')
  expect(withCtrl('1')).toBe('1')
  expect(withCtrl('\x1b[A')).toBe('\x1b[A')
})

test('the key bar sends the usual escape sequences', () => {
  expect(KEY_BYTES.Esc).toBe('\x1b')
  expect(KEY_BYTES.Up).toBe('\x1b[A')
  expect(KEY_BYTES.Tab).toBe('\t')
})

const key = (
  k: string,
  mods: Partial<Record<'ctrlKey' | 'shiftKey' | 'altKey' | 'metaKey', boolean>> = {},
) => ({
  key: k,
  ctrlKey: false,
  shiftKey: false,
  altKey: false,
  metaKey: false,
  ...mods,
})

test('Ctrl+C copies only when something is selected; otherwise it stays the interrupt', () => {
  expect(clipboardKey(key('c', { ctrlKey: true }), true)).toBe('copy')
  expect(clipboardKey(key('C', { ctrlKey: true, shiftKey: true }), true)).toBe('copy')
  expect(clipboardKey(key('c', { ctrlKey: true }), false)).toBeNull()
})

test('Ctrl+V and Ctrl+Shift+V paste; plain keys, Alt and ⌘ are left alone', () => {
  expect(clipboardKey(key('v', { ctrlKey: true }), false)).toBe('paste')
  expect(clipboardKey(key('V', { ctrlKey: true, shiftKey: true }), false)).toBe('paste')
  expect(clipboardKey(key('v'), false)).toBeNull()
  expect(clipboardKey(key('v', { ctrlKey: true, altKey: true }), false)).toBeNull()
  expect(clipboardKey(key('c', { metaKey: true }), true)).toBeNull()
  expect(clipboardKey(key('d', { ctrlKey: true }), true)).toBeNull()
})
