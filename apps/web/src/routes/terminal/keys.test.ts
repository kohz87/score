import { expect, test } from 'vitest'
import { KEY_BYTES, withCtrl } from './keys.ts'

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
