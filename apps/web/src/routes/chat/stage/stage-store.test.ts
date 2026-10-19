import { afterEach, expect, test, vi } from 'vitest'
import { readStageShown, saveStageShown, STAGE_CHANGED } from './stage-store.ts'

afterEach(() => {
  localStorage.clear()
  vi.restoreAllMocks()
  saveStageShown(true)
  localStorage.clear()
})

test('the stage is shown by default and hiding is remembered under score.roomStage', () => {
  expect(readStageShown()).toBe(true)
  saveStageShown(false)
  expect(localStorage.getItem('score.roomStage')).toBe('hidden')
  expect(readStageShown()).toBe(false)
  saveStageShown(true)
  expect(localStorage.getItem('score.roomStage')).toBeNull()
  expect(readStageShown()).toBe(true)
})

test('saving tells the page, so the strip and its toggle follow at once', () => {
  const changed = vi.fn()
  window.addEventListener(STAGE_CHANGED, changed)
  saveStageShown(false)
  window.removeEventListener(STAGE_CHANGED, changed)
  expect(changed).toHaveBeenCalledTimes(1)
})

test('blocked storage still works for this visit and never throws', () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new Error('blocked')
  })
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('blocked')
  })
  vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
    throw new Error('blocked')
  })
  expect(readStageShown()).toBe(true)
  expect(() => saveStageShown(false)).not.toThrow()
  expect(readStageShown()).toBe(false)
})
