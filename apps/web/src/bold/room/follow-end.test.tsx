import { act, cleanup, render } from '@testing-library/react'
import { afterEach, expect, test } from 'vitest'
import { useFollowEnd } from './follow-end.ts'

afterEach(cleanup)

function Stream() {
  const ref = useFollowEnd('room', false)
  return (
    <div ref={ref} data-testid="stream">
      <p>one</p>
    </div>
  )
}

function geometry(el: HTMLElement, height: () => number) {
  Object.defineProperty(el, 'scrollHeight', { configurable: true, get: height })
  Object.defineProperty(el, 'clientHeight', { configurable: true, value: 100 })
}

const tick = () => new Promise((done) => setTimeout(done, 0))

test('a reader who scrolls up is not snapped back by the next mutation, even before the scroll event', async () => {
  const view = render(<Stream />)
  const el = view.getByTestId('stream')
  let height = 1000
  geometry(el, () => height)
  await act(tick)
  // Follows while at the end.
  height = 1200
  el.append(document.createElement('p'))
  await act(tick)
  expect(el.scrollTop).toBe(1200)
  // Scroll up and let a mutation land in the same task: no scroll event has been dispatched yet.
  el.scrollTop = 300
  el.append(document.createElement('p'))
  await act(tick)
  expect(el.scrollTop).toBe(300)
  // Still put when more arrives after the scroll event.
  el.dispatchEvent(new Event('scroll'))
  height = 1400
  el.append(document.createElement('p'))
  await act(tick)
  expect(el.scrollTop).toBe(300)
})

test('a wheel gesture upward leaves the end at once', async () => {
  const view = render(<Stream />)
  const el = view.getByTestId('stream')
  let height = 1000
  geometry(el, () => height)
  await act(tick)
  el.dispatchEvent(new WheelEvent('wheel', { deltaY: -40 }))
  el.scrollTop = 0
  height = 1200
  el.append(document.createElement('p'))
  await act(tick)
  expect(el.scrollTop).toBe(0)
})

test('a stream that gets shorter while the reader is at the end keeps following', async () => {
  const view = render(<Stream />)
  const el = view.getByTestId('stream')
  let height = 1200
  geometry(el, () => height)
  el.append(document.createElement('p'))
  await act(tick)
  expect(el.scrollTop).toBe(1200)
  // A card collapses: the browser clamps scrollTop down with the height; the reader did not move.
  height = 900
  el.scrollTop = 800
  el.dispatchEvent(new Event('scroll'))
  height = 1100
  el.append(document.createElement('p'))
  await act(tick)
  expect(el.scrollTop).toBe(1100)
})
