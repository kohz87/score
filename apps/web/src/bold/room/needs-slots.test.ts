import { expect, test } from 'vitest'
import { withSlot, withoutSlot } from './needs-slots.tsx'

test('a slot removes its entry only while the entry is still its own element', () => {
  const first = document.createElement('div')
  const second = document.createElement('div')
  let map: ReadonlyMap<string, HTMLElement> = new Map()
  map = withSlot(map, 'end', first)
  // A second slot with the same id replaces the entry …
  map = withSlot(map, 'end', second)
  expect(map.get('end')).toBe(second)
  // … and the first one unmounting must not drop it.
  expect(withoutSlot(map, 'end', first)).toBe(map)
  expect(withoutSlot(map, 'end', first).get('end')).toBe(second)
  // The owner removes it.
  expect(withoutSlot(map, 'end', second).has('end')).toBe(false)
})

test('registering the same element again changes nothing', () => {
  const element = document.createElement('div')
  const map = withSlot(new Map(), 'end', element)
  expect(withSlot(map, 'end', element)).toBe(map)
})
