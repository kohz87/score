import type { AgentSummary } from '@score/contract'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { AgentEyeMarker } from './AgentEyeMarker.tsx'

const agent: AgentSummary = {
  id: 'blinker',
  name: 'Blinker',
  role: 'Tests eyes',
  style: { color: '#6B4EFF', shape: 'cloud', avatar: 'r1', avatarEyes: null },
  status: 'idle',
  activity: null,
  model: null,
  served: true,
}

const requests: { path: string; init?: RequestInit }[] = []
let reply: () => Response

beforeEach(() => {
  requests.length = 0
  reply = () =>
    new Response(JSON.stringify(agent), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })
  vi.stubGlobal('fetch', async (path: string, init?: RequestInit) => {
    requests.push({ path, init })
    return reply()
  })
  // A 100x100 picture: dark above row 60, skin (200, 150, 100) below it.
  const data = new Uint8ClampedArray(100 * 100 * 4)
  for (let y = 0; y < 100; y += 1)
    for (let x = 0; x < 100; x += 1)
      data.set(y < 60 ? [10, 10, 10, 255] : [200, 150, 100, 255], (y * 100 + x) * 4)
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
    () =>
      ({ drawImage: () => {}, getImageData: () => ({ width: 100, height: 100, data }) }) as never,
  )
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.restoreAllMocks()
  vi.useRealTimers()
})

function mount(onDone = vi.fn()) {
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { mutations: { retry: false } } })}
    >
      <AgentEyeMarker agent={agent} onDone={onDone} />
    </QueryClientProvider>,
  )
  const stage = document.querySelector('.team-eyes-stage') as HTMLElement
  stage.getBoundingClientRect = () => ({ left: 0, top: 0, width: 500, height: 500 }) as DOMRect
  return {
    stage,
    onDone,
    left: screen.getByRole('group', { name: 'Left eye' }),
    right: screen.getByRole('group', { name: 'Right eye' }),
  }
}

const pct = (element: HTMLElement) => ({
  x: parseFloat(element.style.left),
  y: parseFloat(element.style.top),
  w: parseFloat(element.style.width),
  h: parseFloat(element.style.height),
})

test('shows the picture large with two labelled boxes and the keyboard help', () => {
  const { left, right } = mount()
  expect(screen.getByAltText('Your picture, to mark its eyes on').getAttribute('src')).toBe(
    '/api/agents/blinker/avatar?rev=r1',
  )
  expect(left.tabIndex).toBe(0)
  expect(right.tabIndex).toBe(0)
  expect(pct(left).x).toBeLessThan(pct(right).x)
  expect(screen.getByText(/arrow keys move the focused box/)).toBeDefined()
  expect(left.getAttribute('aria-describedby')).toBe(right.getAttribute('aria-describedby'))
})

test('the arrow keys move a box, Shift moves further, Alt resizes, and nothing leaves the picture', () => {
  const { left } = mount()
  const start = pct(left)
  fireEvent.keyDown(left, { key: 'ArrowRight' })
  expect(pct(left).x).toBeCloseTo(start.x + 1)
  fireEvent.keyDown(left, { key: 'ArrowDown', shiftKey: true })
  expect(pct(left).y).toBeCloseTo(start.y + 5)
  fireEvent.keyDown(left, { key: 'ArrowRight', altKey: true })
  expect(pct(left).w).toBeCloseTo(start.w + 1)
  fireEvent.keyDown(left, { key: 'ArrowDown', altKey: true })
  expect(pct(left).h).toBeCloseTo(start.h + 1)
  for (let i = 0; i < 30; i += 1) fireEvent.keyDown(left, { key: 'ArrowLeft', shiftKey: true })
  expect(pct(left).x).toBe(0)
  for (let i = 0; i < 30; i += 1)
    fireEvent.keyDown(left, { key: 'ArrowUp', altKey: true, shiftKey: true })
  expect(pct(left).h).toBeCloseTo(2)
})

test('dragging a box moves it, and dragging its corner resizes it', () => {
  const { left } = mount()
  const start = pct(left)
  fireEvent.pointerDown(left, { clientX: 100, clientY: 100, pointerId: 1 })
  fireEvent.pointerMove(left, { clientX: 150, clientY: 80, pointerId: 1 })
  fireEvent.pointerUp(left, { pointerId: 1 })
  expect(pct(left).x).toBeCloseTo(start.x + 10)
  expect(pct(left).y).toBeCloseTo(start.y - 4)
  const handle = left.querySelector('.team-eye-handle') as HTMLElement
  const before = pct(left)
  fireEvent.pointerDown(handle, { clientX: 200, clientY: 200, pointerId: 1 })
  fireEvent.pointerMove(handle, { clientX: 225, clientY: 210, pointerId: 1 })
  fireEvent.pointerUp(handle, { pointerId: 1 })
  expect(pct(left).w).toBeCloseTo(before.w + 5)
  expect(pct(left).h).toBeCloseTo(before.h + 2)
  expect(pct(left).x).toBeCloseTo(before.x)
  // Moving after the drag ended does nothing.
  fireEvent.pointerMove(left, { clientX: 400, clientY: 400, pointerId: 1 })
  expect(pct(left).w).toBeCloseTo(before.w + 5)
})

test('the lid colour is sampled from the picture under the boxes and follows them', () => {
  const { left, right } = mount()
  const image = screen.getByAltText('Your picture, to mark its eyes on')
  Object.defineProperty(image, 'naturalWidth', { value: 100 })
  Object.defineProperty(image, 'naturalHeight', { value: 100 })
  fireEvent.load(image)
  // The default boxes end at 50% of the height, so the band under them is still the dark part of the picture.
  expect(screen.getByText('#0A0A0A')).toBeDefined()
  // Moved down 10%, the bands are over the skin.
  for (const box of [left, right]) {
    fireEvent.keyDown(box, { key: 'ArrowDown', shiftKey: true })
    fireEvent.keyDown(box, { key: 'ArrowDown', shiftKey: true })
  }
  expect(screen.getByText('#C89664')).toBeDefined()
})

test('without a canvas the lid falls back to a neutral skin tone', () => {
  vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(() => null)
  mount()
  const image = screen.getByAltText('Your picture, to mark its eyes on')
  Object.defineProperty(image, 'naturalWidth', { value: 100 })
  Object.defineProperty(image, 'naturalHeight', { value: 100 })
  fireEvent.load(image)
  expect(screen.getByText('#D9B8A0')).toBeDefined()
})

test('Save sends the boxes and the lid colour, then finishes', async () => {
  const { left, onDone } = mount()
  fireEvent.keyDown(left, { key: 'ArrowRight' })
  fireEvent.click(screen.getByRole('button', { name: 'Save eyes' }))
  await waitFor(() => expect(onDone).toHaveBeenCalled())
  expect(requests).toHaveLength(1)
  expect(requests[0]!.path).toBe('/api/agents/blinker/avatar/eyes')
  expect(requests[0]!.init?.method).toBe('PUT')
  const body = JSON.parse(String(requests[0]!.init?.body))
  expect(Object.keys(body).sort()).toEqual(['left', 'lid', 'right'])
  expect(body.lid).toMatch(/^#[0-9A-F]{6}$/)
  expect(body.left.x).toBeCloseTo(0.27)
  expect(new Headers(requests[0]!.init?.headers).get('X-Score-Client')).toBe('web')
})

test('a refusal is shown and the step stays open', async () => {
  reply = () =>
    new Response(
      JSON.stringify({
        error: {
          code: 'avatar_rejected',
          message: 'No.',
          details: { reasons: ['The box is outside the picture.'] },
        },
      }),
      { status: 422, headers: { 'content-type': 'application/json' } },
    )
  const { onDone } = mount()
  fireEvent.click(screen.getByRole('button', { name: 'Save eyes' }))
  expect((await screen.findByRole('alert')).textContent).toContain(
    'The box is outside the picture.',
  )
  expect(onDone).not.toHaveBeenCalled()
})

test('Skip finishes without sending anything', () => {
  const { onDone } = mount()
  fireEvent.click(screen.getByRole('button', { name: 'Skip' }))
  expect(onDone).toHaveBeenCalledTimes(1)
  expect(requests).toEqual([])
})

test('the preview blinks on request: its eyes close, then open again', () => {
  vi.useFakeTimers()
  mount()
  const preview = () => document.querySelector('.team-eyes-preview .agent-glyph')!
  expect(preview().classList.contains('agent-glyph--asleep')).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: 'Blink' }))
  expect(preview().classList.contains('agent-glyph--asleep')).toBe(true)
  act(() => vi.advanceTimersByTime(500))
  expect(preview().classList.contains('agent-glyph--asleep')).toBe(false)
  expect(within(preview() as HTMLElement).queryByRole('img')).toBeNull()
})
