import { afterEach, expect, test, vi } from 'vitest'
import { readSendKey, saveSendKey, sendsOnKey } from './send-key.ts'

const key = (
  init: Partial<Record<'shiftKey' | 'ctrlKey' | 'metaKey', boolean>> & { key?: string } = {},
) => ({
  key: 'Enter',
  shiftKey: false,
  ctrlKey: false,
  metaKey: false,
  ...init,
})
afterEach(() => {
  window.localStorage.clear()
  vi.unstubAllGlobals()
})

test('desktop with the default setting: Enter sends, Shift+Enter is a newline', () => {
  expect(sendsOnKey(key(), 'enter', false)).toBe(true)
  expect(sendsOnKey(key({ shiftKey: true }), 'enter', false)).toBe(false)
  expect(sendsOnKey(key({ key: 'a' }), 'enter', false)).toBe(false)
})

test('desktop with Ctrl+Enter: Enter is a newline, Ctrl or Cmd+Enter sends', () => {
  expect(sendsOnKey(key(), 'ctrl-enter', false)).toBe(false)
  expect(sendsOnKey(key({ ctrlKey: true }), 'ctrl-enter', false)).toBe(true)
  expect(sendsOnKey(key({ metaKey: true }), 'ctrl-enter', false)).toBe(true)
})

test('on a touch device Enter always adds a newline, whatever the setting', () => {
  expect(sendsOnKey(key(), 'enter', true)).toBe(false)
  expect(sendsOnKey(key(), 'ctrl-enter', true)).toBe(false)
  expect(sendsOnKey(key({ ctrlKey: true }), 'enter', true)).toBe(true)
})

test('touch is detected from (hover: none) and (pointer: coarse)', () => {
  const matchMedia = vi.fn((query: string) => ({
    matches: query === '(hover: none) and (pointer: coarse)',
  }))
  vi.stubGlobal('matchMedia', matchMedia)
  expect(sendsOnKey(key(), 'enter')).toBe(false)
  vi.stubGlobal('matchMedia', () => ({ matches: false }))
  expect(sendsOnKey(key(), 'enter')).toBe(true)
})

test('the setting is remembered on this device', () => {
  expect(readSendKey()).toBe('enter')
  saveSendKey('ctrl-enter')
  expect(readSendKey()).toBe('ctrl-enter')
  saveSendKey('enter')
  expect(readSendKey()).toBe('enter')
})
