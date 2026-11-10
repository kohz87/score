import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import type { AgentDetail } from '@score/contract'
import { afterEach, expect, test, vi } from 'vitest'
import { agents, disposeRoomTest, jsonResponse, renderInRoom } from '../room/room-test-utils.tsx'
import { ModelChangeForm } from './ModelChangeForm.tsx'

/** Decision 182: changing the agent's model never skips the question about the repeating jobs that follow it. */
afterEach(() => {
  disposeRoomTest()
  vi.unstubAllGlobals()
})

const builder = {
  ...agents.find((agent) => agent.id === 'builder')!,
  model: { id: 'm-2', label: 'Model Two', via: 'a sign-in', fallback: null },
} as AgentDetail

const job = (id: string, model: string | null) => ({
  id,
  title: `Job ${id}`,
  schedule: 'every day',
  description: '',
  lastRunAt: null,
  enabled: true,
  model,
})

type Call = { method: string; path: string }

/** `routines` answers the jobs read in order (a Response, or a gate to hold it); `pin` answers the pin request. */
function stub(options: { routines: Array<Response | Promise<Response>>; pin?: Response }) {
  const calls: Call[] = []
  let read = 0
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const path = String(input)
      const method = init?.method ?? 'GET'
      calls.push({ method, path })
      if (path.endsWith('/routines/pin')) return options.pin ?? jsonResponse({ pinned: [] })
      if (path.endsWith('/agents/builder/routines')) {
        const next = options.routines[Math.min(read, options.routines.length - 1)]!
        read += 1
        return next
      }
      return jsonResponse({}, 404)
    }),
  )
  return calls
}

function render() {
  renderInRoom(<ModelChangeForm agent={builder} />, ['/b/team/builder'])
  fireEvent.change(screen.getByLabelText('Model'), { target: { value: 'other-model' } })
}

test('while the jobs are being read the change can’t be saved', async () => {
  stub({ routines: [new Promise<Response>(() => undefined)] })
  render()
  const button = screen.getByRole('button', { name: 'Checking repeating jobs…' })
  expect((button as HTMLButtonElement).disabled).toBe(true)
})

test('when the jobs can’t be read, Save and Retry both ask first and "Change anyway" goes ahead', async () => {
  const calls = stub({ routines: [jsonResponse({}, 503)] })
  render()
  await waitFor(() =>
    expect(
      (screen.getByRole('button', { name: 'Change model' }) as HTMLButtonElement).disabled,
    ).toBe(false),
  )
  fireEvent.click(screen.getByRole('button', { name: 'Change model' }))
  const card = await screen.findByText(/Couldn’t check whether repeating jobs follow/)
  expect(card.closest('[data-protected]')).toBeTruthy()
  expect(calls.some((call) => call.method === 'PUT')).toBe(false)
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  expect(screen.queryByText(/Couldn’t check whether/)).toBeNull()
  fireEvent.click(screen.getByRole('button', { name: 'Change model' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Change anyway' }))
  await waitFor(() => expect(calls.some((call) => call.path.endsWith('/model'))).toBe(true))
})

test('a failed pin says which jobs were pinned and leaves the model alone', async () => {
  const calls = stub({
    routines: [
      jsonResponse({ items: [job('a', null), job('b', null)] }),
      jsonResponse({ items: [job('a', 'm-2'), job('b', null)] }),
    ],
    pin: jsonResponse({ error: { code: 'conflict', message: 'Refused.' } }, 409),
  })
  render()
  await waitFor(() =>
    expect(
      (screen.getByRole('button', { name: 'Change model' }) as HTMLButtonElement).disabled,
    ).toBe(false),
  )
  fireEvent.click(screen.getByRole('button', { name: 'Change model' }))
  fireEvent.click(await screen.findByRole('button', { name: /Keep the jobs on m-2/ }))
  const alert = await screen.findByText(/Hermes refused to pin a job/)
  await waitFor(() =>
    expect(alert.textContent).toContain('1 job was pinned before that and keeps m-2.'),
  )
  expect(alert.textContent).toContain('builder’s model wasn’t changed')
  expect(calls.some((call) => call.path.endsWith('/model'))).toBe(false)
  expect(
    within(alert.closest('[data-protected]') as HTMLElement).getByRole('button', {
      name: 'Cancel',
    }),
  ).toBeTruthy()
})
