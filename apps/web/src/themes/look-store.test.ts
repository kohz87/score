import { beforeEach, expect, test, vi } from 'vitest'
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

// Gate finding #9: blocked storage must not stop the reset; the in-memory state decides what is applied.
test('reset works when localStorage throws on every read and write', () => {
  writeDeviceOverride('hostile')
  expect(lookStore.get().device).toBe('hostile')
  const blocked = () => {
    throw new DOMException('blocked', 'SecurityError')
  }
  const spies = [
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(blocked),
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(blocked),
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(blocked),
  ]
  try {
    clearDeviceLook()
    expect(lookStore.get().device).toBe('score')
    writeDeviceOverride('paper')
    expect(lookStore.get().device).toBe('paper')
    writeDeviceOverride(null)
    expect(lookStore.get().device).toBeNull()
    clearDeviceLook()
    expect(lookStore.get().device).toBe('score')
  } finally {
    spies.forEach((spy) => spy.mockRestore())
  }
})
