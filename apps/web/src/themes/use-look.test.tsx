import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import {
  applyResetGeneration,
  clearDeviceLook,
  lookStore,
  writeDeviceOverride,
  writeLookCache,
} from './look-store.ts'
import { resetForgottenTheme } from '../data/theme.ts'
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
const themes = (resetGeneration?: number, active = 'score') => ({
  items: ['score', 'paper', 'hostile'].map(item),
  active,
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
  resetForgottenTheme()
  lookStore.reset()
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

test('a device override from before a host reset is dropped, with the boot cache', async () => {
  // Saved by an earlier visit: it is in storage when the page starts, not chosen on this page.
  window.localStorage.setItem('score.look.device', 'hostile')
  lookStore.reset()
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
  window.localStorage.setItem('score.look.device', 'hostile')
  lookStore.reset()
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

// Gate re-check finding #9: the host reset also clears the device's light/dark choice (`score.theme`), or a stored
// "dark" overrides the shared mode the host just reset to "system".
function ModeProbe() {
  const look = useLook()
  return <p data-testid="mode">{look.mode}</p>
}
function mountMode(body: unknown) {
  vi.stubGlobal(
    'fetch',
    vi.fn(() => Promise.resolve(Response.json(body))),
  )
  return render(
    <QueryClientProvider client={new QueryClient()}>
      <ModeProbe />
    </QueryClientProvider>,
  )
}

test('a host reset clears the device’s light/dark choice too (storage and memory)', async () => {
  window.localStorage.setItem('score.theme', 'dark')
  mountMode(themes(1))
  await waitFor(() => expect(screen.getByTestId('mode').textContent).toBe('system'))
  expect(window.localStorage.getItem('score.theme')).toBeNull()
})

test('the colour-mode drop holds for this visit when storage refuses the removal', async () => {
  window.localStorage.setItem('score.theme', 'dark')
  const remove = vi.spyOn(Storage.prototype, 'removeItem').mockImplementation(() => {
    throw new Error('blocked')
  })
  try {
    mountMode(themes(2))
    await waitFor(() => expect(screen.getByTestId('mode').textContent).toBe('system'))
  } finally {
    remove.mockRestore()
  }
})

test('a colour mode chosen after the reset (same generation) stays', async () => {
  window.localStorage.setItem('score.look.generation', '1')
  window.localStorage.setItem('score.theme', 'dark')
  mountMode(themes(1))
  await waitFor(() => expect(screen.getByTestId('mode').textContent).toBe('dark'))
})

// Cross-audit X15: a reset made on this page before the theme list arrives (Ctrl+Shift+0, or the guard's fallback)
// is newer than anything the host's reset generation can say about, so the late list must not undo it.
test('Ctrl+Shift+0 before the list arrives survives a list whose reset generation is ahead of this device’s', async () => {
  clearDeviceLook()
  mount(themes(1, 'hostile'))
  await waitFor(() => expect(window.localStorage.getItem('score.look.generation')).toBe('1'))
  expect(screen.getByTestId('effective').textContent).toBe('score')
  expect(window.localStorage.getItem('score.look.device')).toBe('score')
})

test('the guard’s fallback before the list arrives survives it too', async () => {
  writeDeviceOverride('score')
  mount(themes(3, 'hostile'))
  await waitFor(() => expect(window.localStorage.getItem('score.look.generation')).toBe('3'))
  expect(screen.getByTestId('effective').textContent).toBe('score')
})

test('a host reset that comes after the list was read still reaches a device that chose its own theme', () => {
  writeDeviceOverride('paper')
  applyResetGeneration(1)
  expect(lookStore.get().device).toBe('paper')
  applyResetGeneration(2)
  expect(lookStore.get().device).toBeNull()
  expect(window.localStorage.getItem('score.look.generation')).toBe('2')
})
