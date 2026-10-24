import { afterEach, expect, test, vi } from 'vitest'
import {
  LIVELINESS_CHANGED,
  effectiveLiveliness,
  readLiveliness,
  readStoredLiveliness,
  saveLiveliness,
  watchLiveliness,
} from './liveliness.ts'

function media(matches: Record<string, boolean>) {
  vi.stubGlobal('matchMedia', (query: string) => ({
    matches: matches[query] ?? false,
    addEventListener: () => undefined,
    removeEventListener: () => undefined,
  }))
}

afterEach(() => {
  localStorage.clear()
  vi.unstubAllGlobals()
})

test('Calm is the default and a saved choice is read back', () => {
  media({})
  expect(readStoredLiveliness()).toBeNull()
  expect(readLiveliness()).toBe('calm')
  saveLiveliness('still')
  expect(localStorage.getItem('score.liveliness')).toBe('still')
  expect(readLiveliness()).toBe('still')
})

test('saving Calm forgets the key, and saving fires the change event', () => {
  media({})
  const changed = vi.fn()
  window.addEventListener(LIVELINESS_CHANGED, changed)
  saveLiveliness('still')
  saveLiveliness('calm')
  window.removeEventListener(LIVELINESS_CHANGED, changed)
  expect(localStorage.getItem('score.liveliness')).toBeNull()
  expect(changed).toHaveBeenCalledTimes(2)
})

test('an unknown stored value is ignored, and the removed Lively reads as Calm', () => {
  media({})
  localStorage.setItem('score.liveliness', 'frantic')
  expect(readStoredLiveliness()).toBeNull()
  expect(readLiveliness()).toBe('calm')
  localStorage.setItem('score.liveliness', 'lively')
  expect(readStoredLiveliness()).toBeNull()
  expect(readLiveliness()).toBe('calm')
})

test('reduced motion means Still, whatever was chosen', () => {
  media({ '(prefers-reduced-motion: reduce)': true })
  saveLiveliness('calm')
  expect(readLiveliness()).toBe('calm')
  expect(effectiveLiveliness()).toBe('still')
})

test('blocked storage still gives the default', () => {
  media({})
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new Error('blocked')
  })
  expect(readLiveliness()).toBe('calm')
  vi.restoreAllMocks()
})

test('the page root mirrors the effective liveliness and follows a new choice', () => {
  media({})
  const stop = watchLiveliness()
  expect(document.documentElement.dataset.liveliness).toBe('calm')
  saveLiveliness('still')
  expect(document.documentElement.dataset.liveliness).toBe('still')
  saveLiveliness('calm')
  expect(document.documentElement.dataset.liveliness).toBe('calm')
  stop()
  saveLiveliness('still')
  expect(document.documentElement.dataset.liveliness).toBe('calm')
  delete document.documentElement.dataset.liveliness
})

test('reduced motion is Still on the page root whatever was chosen', () => {
  media({ '(prefers-reduced-motion: reduce)': true })
  saveLiveliness('calm')
  const stop = watchLiveliness()
  expect(document.documentElement.dataset.liveliness).toBe('still')
  stop()
  delete document.documentElement.dataset.liveliness
})
