import { afterEach, expect, test, vi } from 'vitest'
import { applyUiParam, readUi, saveUi } from './bold-ui.ts'

afterEach(() => {
  vi.unstubAllGlobals()
  window.localStorage.clear()
  window.history.replaceState(null, '', '/')
})

test('the shell defaults to bold and remembers classic', () => {
  expect(readUi()).toBe('bold')
  saveUi('bold')
  expect(readUi()).toBe('bold')
  expect(window.localStorage.getItem('score.ui')).toBeNull()
  saveUi('classic')
  expect(readUi()).toBe('classic')
  expect(window.localStorage.getItem('score.ui')).toBe('classic')
})

test('?ui=bold and ?ui=classic choose the shell from any address', () => {
  applyUiParam('?ui=bold')
  expect(readUi()).toBe('bold')
  applyUiParam('?ui=classic')
  expect(readUi()).toBe('classic')
  applyUiParam('?ui=something-else')
  expect(readUi()).toBe('classic')

  window.history.replaceState(null, '', '/b?ui=bold')
  expect(readUi()).toBe('bold')
  window.history.replaceState(null, '', '/b/team?ui=classic')
  expect(readUi()).toBe('classic')
})

test('blocked storage never throws and falls back to bold', () => {
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
  window.history.replaceState(null, '', '/?ui=bold')
  expect(readUi()).toBe('bold')
  expect(() => {
    saveUi('bold')
    applyUiParam('?ui=classic')
  }).not.toThrow()
})
