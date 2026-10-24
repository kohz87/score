import { afterEach, expect, test, vi } from 'vitest'
import {
  normalizeTextScale,
  readTextScale,
  saveTextScale,
  TEXT_SCALE_MAX,
  TEXT_SCALE_MIN,
} from './text-scale.ts'

afterEach(() => {
  vi.unstubAllGlobals()
  window.localStorage.clear()
})

test('text size is remembered on this device and the default is not stored', () => {
  expect(readTextScale()).toBe(1)
  saveTextScale(1.1)
  expect(readTextScale()).toBe(1.1)
  expect(window.localStorage.getItem('score.textScale')).toBe('1.1')
  saveTextScale(1)
  expect(readTextScale()).toBe(1)
  expect(window.localStorage.getItem('score.textScale')).toBeNull()
})

test('text size snaps to the five-percent steps and stays in range', () => {
  expect(normalizeTextScale(0.71)).toBe(TEXT_SCALE_MIN)
  expect(normalizeTextScale(1.33)).toBe(TEXT_SCALE_MAX)
  expect(normalizeTextScale(1.074)).toBe(1.05)
  expect(normalizeTextScale(Number.NaN)).toBe(1)
})

test('blocked storage falls back to the default instead of breaking the page', () => {
  vi.stubGlobal('localStorage', {
    getItem: () => {
      throw new Error('blocked')
    },
    setItem: () => {
      throw new Error('blocked')
    },
    removeItem: () => {
      throw new Error('blocked')
    },
  })
  expect(readTextScale()).toBe(1)
  expect(() => saveTextScale(1.2)).not.toThrow()
})
