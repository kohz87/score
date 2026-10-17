import { beforeEach, expect, test } from 'vitest'
import {
  clearDeviceLook,
  lookStore,
  readDeviceOverride,
  writeDeviceOverride,
  writeLookCache,
} from './look-store.ts'

beforeEach(() => {
  window.localStorage.clear()
  lookStore.reset()
})

test('the device override is a theme id, or the pack an earlier Score saved here', () => {
  expect(readDeviceOverride()).toBeNull()
  window.localStorage.setItem('score.look', JSON.stringify({ pack: 'night' }))
  expect(readDeviceOverride()).toBe('night')
  writeDeviceOverride('harbour')
  expect(readDeviceOverride()).toBe('harbour')
  writeDeviceOverride(null)
  expect(readDeviceOverride()).toBeNull()
  expect(window.localStorage.getItem('score.look')).toBeNull()
  window.localStorage.setItem('score.look.device', '../evil')
  expect(readDeviceOverride()).toBeNull()
})

test('reset sends this device to Score’s own look and drops the cache', () => {
  writeDeviceOverride('harbour')
  writeLookCache({ id: 'harbour', attributes: { 'data-look': 'custom' }, css: '' })
  clearDeviceLook()
  expect(readDeviceOverride()).toBe('score')
  expect(window.localStorage.getItem('score.look.cache')).toBeNull()
})
