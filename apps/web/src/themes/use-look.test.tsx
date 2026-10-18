import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { lookStore, writeDeviceOverride, writeLookCache } from './look-store.ts'
import { useLook } from './use-look.ts'

// Gate finding #10: `scripts/score look reset` bumps the server's reset generation; a browser that kept its own
// override (or boot cache) from before it must drop them, or the reset never reaches that device.

const item = (id: string) => ({
  id,
  name: id,
  version: '1.0.0',
  author: null,
  description: null,
  source: 'imported',
  updatedAt: '2026-10-17T00:00:00.000Z',
  hasCss: true,
})
const themes = (resetGeneration?: number) => ({
  items: ['score', 'paper', 'hostile'].map(item),
  active: 'score',
  mode: 'system',
  ...(resetGeneration === undefined ? {} : { resetGeneration }),
})

function Probe() {
  const look = useLook()
  return <p data-testid="effective">{look.effectiveId}</p>
}
function mount(body: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(Response.json(body))),
  )
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <Probe />
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  window.localStorage.clear()
  lookStore.reset()
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

test('a device override from before a host reset is dropped, with the boot cache', async () => {
  writeDeviceOverride('hostile')
  writeLookCache({ id: 'hostile', attributes: { 'data-look': 'custom' }, css: 'body{}' })
  mount(themes(1))
  await waitFor(() => expect(screen.getByTestId('effective').textContent).toBe('score'))
  await waitFor(() => expect(window.localStorage.getItem('score.look.generation')).toBe('1'))
  expect(window.localStorage.getItem('score.look.device')).toBeNull()
  expect(window.localStorage.getItem('score.look.cache')).toBeNull()
})

test('an override chosen after the reset (same generation) stays', async () => {
  window.localStorage.setItem('score.look.generation', '1')
  lookStore.reset()
  writeDeviceOverride('paper')
  mount(themes(1))
  await waitFor(() => expect(screen.getByTestId('effective').textContent).toBe('paper'))
  expect(window.localStorage.getItem('score.look.device')).toBe('paper')
})

test('a server that never reset (generation 0 or absent) leaves overrides alone', async () => {
  writeDeviceOverride('paper')
  mount(themes())
  await waitFor(() => expect(screen.getByTestId('effective').textContent).toBe('paper'))
  expect(window.localStorage.getItem('score.look.device')).toBe('paper')
})

test('the reset also holds when storage is blocked: the override is dropped in memory', async () => {
  writeDeviceOverride('hostile')
  const blocked = () => {
    throw new DOMException('blocked', 'SecurityError')
  }
  const spies = [
    vi.spyOn(Storage.prototype, 'getItem').mockImplementation(blocked),
    vi.spyOn(Storage.prototype, 'setItem').mockImplementation(blocked),
    vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(blocked),
  ]
  try {
    mount(themes(2))
    await waitFor(() => expect(screen.getByTestId('effective').textContent).toBe('score'))
  } finally {
    spies.forEach((spy) => spy.mockRestore())
  }
})
