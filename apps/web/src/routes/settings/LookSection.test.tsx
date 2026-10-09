import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { LookSection } from './LookSection.tsx'

afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

test('Display currency saves the typed code and rate', async () => {
  const fetch = vi.fn((_url: string, init?: RequestInit) =>
    Promise.resolve(
      Response.json(
        init?.method === 'PUT' ? JSON.parse(String(init.body)) : { code: 'USD', rate: 1 },
      ),
    ),
  )
  vi.stubGlobal('fetch', fetch)
  render(
    <QueryClientProvider client={new QueryClient()}>
      <LookSection />
    </QueryClientProvider>,
  )
  const save = screen.getByRole('button', { name: 'Save' })
  fireEvent.change(await screen.findByLabelText('Currency code'), { target: { value: 'eur' } })
  fireEvent.change(screen.getByLabelText('Rate (1 USD =)'), { target: { value: '0.92' } })
  fireEvent.click(save)
  await screen.findByText('Saved.')
  const put = fetch.mock.calls.find(([, init]) => init?.method === 'PUT')!
  expect(JSON.parse(String(put[1]!.body))).toEqual({ code: 'EUR', rate: 0.92 })
  fireEvent.change(screen.getByLabelText('Rate (1 USD =)'), { target: { value: '0' } })
  await waitFor(() =>
    expect(screen.getByRole('button', { name: 'Save' }).hasAttribute('disabled')).toBe(true),
  )
})
