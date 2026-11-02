import { expect, test } from 'vitest'
import { InputBatcher } from './batcher.ts'
import { charToKeysym, keyToKeysym, SHORTCUTS, textToEvents } from './keysyms.ts'
import { click, rfbButtons, toScreenPoint, wheelNotch } from './pointer.ts'

test('printable keys map to their code point', () => {
  expect(keyToKeysym('a')).toBe(0x61)
  expect(keyToKeysym(' ')).toBe(0x20)
  expect(keyToKeysym('~')).toBe(0x7e)
  expect(keyToKeysym('é')).toBe(0xe9)
  expect(keyToKeysym(' ')).toBe(0xa0)
})

test('other code points use the Unicode keysym range', () => {
  expect(keyToKeysym('€')).toBe(0x01000000 + 0x20ac)
  expect(keyToKeysym('😀')).toBe(0x01000000 + 0x1f600)
  expect(charToKeysym('Ā')).toBe(0x01000100)
})

test('named keys', () => {
  expect(keyToKeysym('Enter')).toBe(0xff0d)
  expect(keyToKeysym('Backspace')).toBe(0xff08)
  expect(keyToKeysym('Tab')).toBe(0xff09)
  expect(keyToKeysym('Escape')).toBe(0xff1b)
  expect(keyToKeysym('Delete')).toBe(0xffff)
  expect(keyToKeysym('ArrowLeft')).toBe(0xff51)
  expect(keyToKeysym('ArrowDown')).toBe(0xff54)
  expect(keyToKeysym('PageDown')).toBe(0xff56)
  expect(keyToKeysym('F1')).toBe(0xffbe)
  expect(keyToKeysym('F12')).toBe(0xffc9)
  expect(keyToKeysym('Shift')).toBe(0xffe1)
  expect(keyToKeysym('Control')).toBe(0xffe3)
  expect(keyToKeysym('Alt')).toBe(0xffe9)
  expect(keyToKeysym('Meta')).toBe(0xffeb)
  expect(keyToKeysym('CapsLock')).toBe(0xffe5)
  expect(keyToKeysym('ContextMenu')).toBe(0xff67)
})

test('everything else is ignored', () => {
  expect(keyToKeysym('Dead')).toBeNull()
  expect(keyToKeysym('Unidentified')).toBeNull()
  expect(keyToKeysym('F13')).toBeNull()
  expect(keyToKeysym('')).toBeNull()
  expect(keyToKeysym('\u0001')).toBeNull()
  expect(keyToKeysym('\u0085')).toBeNull()
})

test('typed text is a down and an up per character; line breaks are Enter', () => {
  expect(textToEvents('a\n')).toEqual([
    { k: 'key', keysym: 0x61, down: true },
    { k: 'key', keysym: 0x61, down: false },
    { k: 'key', keysym: 0xff0d, down: true },
    { k: 'key', keysym: 0xff0d, down: false },
  ])
})

test('shortcuts press modifiers around the key', () => {
  const copy = SHORTCUTS.find((s) => s.label === 'Ctrl+C')!.events
  expect(copy.map((e) => [e.keysym, e.down])).toEqual([
    [0xffe3, true],
    [0x63, true],
    [0x63, false],
    [0xffe3, false],
  ])
  expect(SHORTCUTS.map((s) => s.label)).toEqual([
    'Ctrl+C',
    'Ctrl+V',
    'Ctrl+L',
    'Ctrl+A',
    'Alt+Tab',
    'Esc',
    'Enter',
  ])
})

test('pointer position scales to screen pixels and is clamped', () => {
  const rect = { left: 100, top: 50, width: 500, height: 250 }
  expect(toScreenPoint(350, 175, rect, 1000, 500)).toEqual({ x: 500, y: 250 })
  expect(toScreenPoint(100, 50, rect, 1000, 500)).toEqual({ x: 0, y: 0 })
  expect(toScreenPoint(9999, 9999, rect, 1000, 500)).toEqual({ x: 999, y: 499 })
  expect(toScreenPoint(0, 0, rect, 1000, 500)).toEqual({ x: 0, y: 0 })
  expect(toScreenPoint(101, 51, rect, 1000, 500)).toEqual({ x: 2, y: 2 })
})

test('DOM buttons map to the RFB mask', () => {
  expect(rfbButtons(1)).toBe(1)
  expect(rfbButtons(4)).toBe(2)
  expect(rfbButtons(2)).toBe(4)
  expect(rfbButtons(7)).toBe(7)
  expect(rfbButtons(0)).toBe(0)
})

test('wheel notches press and release; clicks move, press, release', () => {
  expect(wheelNotch(1, 2, true).map((e) => e.buttons)).toEqual([8, 0])
  expect(wheelNotch(1, 2, false).map((e) => e.buttons)).toEqual([16, 0])
  expect(click(1, 2, 4).map((e) => e.buttons)).toEqual([0, 4, 0])
})

test('the batcher collapses pointer runs, keeps presses, and takes at most 200', () => {
  const batcher = new InputBatcher()
  for (let i = 0; i < 50; i++) batcher.push({ k: 'pointer', x: i, y: 0, buttons: 0 })
  expect(batcher.size).toBe(2)
  batcher.push({ k: 'pointer', x: 5, y: 5, buttons: 1 }, { k: 'pointer', x: 5, y: 5, buttons: 0 })
  expect(batcher.size).toBe(4)
  const big = new InputBatcher()
  for (let i = 0; i < 450; i++) big.push({ k: 'key', keysym: 0x61, down: i % 2 === 0 })
  expect(big.take()).toHaveLength(200)
  expect(big.take()).toHaveLength(200)
  expect(big.take()).toHaveLength(50)
})
