import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { BotScreenStatus } from '@score/contract'
import { BoldLiveScreen } from './BoldLiveScreen.tsx'

let status: BotScreenStatus = { state: 'off' }
let calls = 0

beforeEach(() => {
  status = { state: 'off' }
  calls = 0
  window.localStorage.clear()
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => {
      calls++
      return new Response(JSON.stringify(status), {
        status: 200,
        headers: { 'content-type': 'application/json' },
      })
    }),
  )
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
  vi.useRealTimers()
})

function renderCard() {
  const client = new QueryClient({ defaultOptions: { queries: { gcTime: 0 } } })
  return render(
    <QueryClientProvider client={client}>
      <BoldLiveScreen agentId="builder" agentName="builder" />
    </QueryClientProvider>,
  )
}

test('running shows the frame, scaled by its size, with no handlers', async () => {
  status = { state: 'running', width: 960, height: 600, frameSeq: 3 }
  renderCard()
  const img = (await screen.findByAltText('builder’s screen, live')) as HTMLImageElement
  expect(img.getAttribute('src')).toBe('/api/agents/builder/bot-screen/frame?seq=3')
  expect(img.style.aspectRatio).toBe('960 / 600')
  expect(screen.getByText('Read-only')).toBeDefined()
})

test.each([
  [{ state: 'off' }, 'The screen is off.'],
  [
    { state: 'sandboxed' },
    'This screen runs inside the agent’s sandbox, where Score can’t show it.',
  ],
  [
    { state: 'unavailable', reason: 'Bridge is down.' },
    'Score can’t show this screen. Bridge is down.',
  ],
] as [BotScreenStatus, string][])('%j shows its line', async (value, text) => {
  status = value
  renderCard()
  expect(await screen.findByText(text)).toBeDefined()
})

test('human is a protected privacy line', async () => {
  status = { state: 'human' }
  renderCard()
  const line = await screen.findByText(
    'Someone has taken over this screen. Score hides it while they work.',
  )
  expect(line.hasAttribute('data-protected')).toBe(true)
})

test('the frame URL changes only when frameSeq changes', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  status = { state: 'running', width: 10, height: 10, frameSeq: 1 }
  renderCard()
  const img = () => screen.getByAltText('builder’s screen, live').getAttribute('src')
  await waitFor(() => expect(img()).toContain('seq=1'))
  const before = calls
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1100)
  })
  expect(calls).toBeGreaterThan(before)
  expect(img()).toContain('seq=1')
  status = { state: 'running', width: 10, height: 10, frameSeq: 2 }
  await act(async () => {
    await vi.advanceTimersByTimeAsync(1100)
  })
  await waitFor(() => expect(img()).toContain('seq=2'))
})

test('hiding stops polling and is remembered; showing resumes', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  status = { state: 'running', width: 10, height: 10, frameSeq: 1 }
  renderCard()
  await screen.findByAltText('builder’s screen, live')
  await act(async () => {
    screen.getByRole('button', { name: 'Hide' }).click()
  })
  expect(screen.queryByAltText('builder’s screen, live')).toBeNull()
  expect(window.localStorage.getItem('score.botScreen.hidden')).toBe('1')
  const before = calls
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000)
  })
  expect(calls).toBe(before)
  await act(async () => {
    screen.getByRole('button', { name: 'Show' }).click()
  })
  await screen.findByAltText('builder’s screen, live')
})

test('starts collapsed when it was hidden before, without asking', async () => {
  window.localStorage.setItem('score.botScreen.hidden', '1')
  renderCard()
  expect(screen.getByRole('button', { name: 'Show' })).toBeDefined()
  expect(calls).toBe(0)
})

test('no polling while the page is hidden', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  status = { state: 'running', width: 10, height: 10, frameSeq: 1 }
  renderCard()
  await screen.findByAltText('builder’s screen, live')
  Object.defineProperty(document, 'visibilityState', { value: 'hidden', configurable: true })
  await act(async () => {
    document.dispatchEvent(new Event('visibilitychange'))
  })
  const before = calls
  await act(async () => {
    await vi.advanceTimersByTimeAsync(5000)
  })
  expect(calls).toBe(before)
  Object.defineProperty(document, 'visibilityState', { value: 'visible', configurable: true })
})
