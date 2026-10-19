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

test('Lively is the default and a saved choice is read back', () => {
  media({})
  expect(readStoredLiveliness()).toBeNull()
  expect(readLiveliness()).toBe('lively')
  saveLiveliness('calm')
  expect(localStorage.getItem('score.liveliness')).toBe('calm')
  expect(readLiveliness()).toBe('calm')
})

test('saving Lively forgets the key, and saving fires the change event', () => {
  media({})
  const changed = vi.fn()
  window.addEventListener(LIVELINESS_CHANGED, changed)
  saveLiveliness('still')
  saveLiveliness('lively')
  window.removeEventListener(LIVELINESS_CHANGED, changed)
  expect(localStorage.getItem('score.liveliness')).toBeNull()
  expect(changed).toHaveBeenCalledTimes(2)
})

test('an unknown stored value is ignored', () => {
  media({})
  localStorage.setItem('score.liveliness', 'frantic')
  expect(readStoredLiveliness()).toBeNull()
  expect(readLiveliness()).toBe('lively')
})

test('below 600px wide the default is Calm, but a saved choice wins', () => {
  media({ '(max-width: 599px)': true })
  expect(readLiveliness()).toBe('calm')
  saveLiveliness('lively')
  expect(readLiveliness()).toBe('lively')
})

test('reduced motion means Still, whatever was chosen', () => {
  media({ '(prefers-reduced-motion: reduce)': true })
  saveLiveliness('lively')
  expect(readLiveliness()).toBe('lively')
  expect(effectiveLiveliness()).toBe('still')
})

test('blocked storage still gives the default', () => {
  media({})
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new Error('blocked')
  })
  expect(readLiveliness()).toBe('lively')
  vi.restoreAllMocks()
})

test('choosing Lively on a phone is remembered, so it does not fall back to Calm', () => {
  media({ '(max-width: 599px)': true })
  saveLiveliness('lively')
  expect(localStorage.getItem('score.liveliness')).toBe('lively')
  expect(readLiveliness()).toBe('lively')
})

test('the page root mirrors the effective liveliness and follows a new choice', () => {
  media({})
  const stop = watchLiveliness()
  expect(document.documentElement.dataset.liveliness).toBe('lively')
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
  saveLiveliness('lively')
  const stop = watchLiveliness()
  expect(document.documentElement.dataset.liveliness).toBe('still')
  stop()
  delete document.documentElement.dataset.liveliness
})
