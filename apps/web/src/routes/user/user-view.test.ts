import { afterEach, expect, test, vi } from 'vitest'
import {
  readGuard,
  readLastRoom,
  readView,
  saveGuard,
  saveLastRoom,
  saveView,
  userPathFor,
  userRoomPath,
} from './user-view.ts'

afterEach(() => {
  vi.unstubAllGlobals()
  window.localStorage.clear()
})

test('the view defaults to admin and is remembered once chosen', () => {
  expect(readView()).toBe('admin')
  saveView('user')
  expect(readView()).toBe('user')
  saveView('admin')
  expect(readView()).toBe('admin')
  expect(window.localStorage.getItem('score.view')).toBeNull()
})

test('the guard is off until it is turned on', () => {
  expect(readGuard()).toBe(false)
  saveGuard(true)
  expect(readGuard()).toBe(true)
  saveGuard(false)
  expect(readGuard()).toBe(false)
})

test('blocked storage never throws and falls back to the defaults', () => {
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
  expect(readView()).toBe('admin')
  expect(readGuard()).toBe(false)
  expect(readLastRoom()).toBeNull()
  expect(() => {
    saveView('user')
    saveGuard(true)
    saveLastRoom('r1')
  }).not.toThrow()
})

test('room addresses map between the two views', () => {
  expect(userRoomPath('room 1')).toBe('/u/rooms/room%201')
  expect(userPathFor('/chat/abc')).toBe('/u/rooms/abc')
  expect(userPathFor('/now')).toBeNull()
})
