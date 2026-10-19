import { expect, test } from 'vitest'
import { KEY_BYTES, OSC52_MAX_BYTES, clipboardKey, osc52Text, withCtrl } from './keys.ts'

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

const b64 = (text: string) => btoa(String.fromCharCode(...new TextEncoder().encode(text)))

test('OSC 52 from tmux: the selection text, UTF-8 included', () => {
  expect(osc52Text(`c;${b64('git status')}`)).toBe('git status')
  expect(osc52Text(`;${b64('héllo ✓')}`)).toBe('héllo ✓')
  expect(osc52Text(`pc;${b64('x')}`)).toBe('x')
})

test('OSC 52 never reads the clipboard and refuses anything malformed or oversized', () => {
  expect(osc52Text('c;?')).toBeNull()
  expect(osc52Text('c;')).toBeNull()
  expect(osc52Text('no-separator')).toBeNull()
  expect(osc52Text('x;aGk=')).toBeNull()
  expect(osc52Text('c;not base64!')).toBeNull()
  expect(osc52Text(`c;${btoa(String.fromCharCode(0xff, 0xfe))}`)).toBeNull()
  expect(osc52Text(`c;${btoa('a'.repeat(OSC52_MAX_BYTES + 1))}`)).toBeNull()
})
