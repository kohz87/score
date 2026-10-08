import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { ModelPicker, type ModelChoice } from './ModelPicker.tsx'

const all = [
  {
    provider: 'openai-codex',
    providerLabel: 'ChatGPT (Codex)',
    model: 'gpt-6.1-sol',
    available: true,
    reason: null,
    free: false,
    price: { input: '$2.00', output: '$10.00' },
  },
  {
    provider: 'nous',
    providerLabel: 'Nous Portal',
    model: 'openai/gpt-6.1-sol',
    available: false,
    reason: 'Not on your plan',
    free: false,
    price: null,
  },
  {
    provider: 'nous',
    providerLabel: 'Nous Portal',
    model: 'upstage/solar-mini4:free',
    available: true,
    reason: null,
    free: true,
    price: null,
  },
]
let urls: string[]
let latest: ModelChoice
let failing = false
beforeEach(() => {
  urls = []
  latest = { model: '', provider: null }
  failing = false
  vi.stubGlobal(
    'fetch',
    vi.fn((path: string) => {
      urls.push(path)
      if (failing) return Promise.resolve(new Response('{}', { status: 500 }))
      const q = new URL(path, 'http://x').searchParams.get('q')?.toLowerCase() ?? ''
      const items = all.filter((o) => o.model.includes(q))
      return Promise.resolve(Response.json({ items }))
    }),
  )
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function Host() {
  const [value, setValue] = useState<ModelChoice>({ model: '', provider: null })
  return (
    <ModelPicker
      label="Model"
      value={value}
      onChange={(next) => {
        latest = next
        setValue(next)
      }}
    />
  )
}
function mount() {
  render(
    <QueryClientProvider
      client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}
    >
      <Host />
    </QueryClientProvider>,
  )
  return screen.getByRole('combobox', { name: 'Model' })
}

test('typing lists matches grouped by provider with price, free and plan reason', async () => {
  const input = mount()
  fireEvent.focus(input)
  fireEvent.change(input, { target: { value: 'gpt' } })
  const list = await screen.findByRole('listbox', { name: 'Model suggestions' })
  await waitFor(() =>
    expect(urls.some((u) => u.endsWith('models?q=gpt'.replace('models', '/api/models')))).toBe(
      true,
    ),
  )
  await waitFor(() => expect(within(list).getAllByRole('option')).toHaveLength(2))
  expect(within(list).getByRole('group', { name: 'ChatGPT (Codex)' })).toBeTruthy()
  expect(within(list).getByText('$2.00 / $10.00 per 1M')).toBeTruthy()
  const disabled = within(list).getByRole('option', { name: /openai\/gpt-6.1-sol/ })
  expect(disabled.getAttribute('aria-disabled')).toBe('true')
  expect(within(disabled).getByText('Not on your plan')).toBeTruthy()
  expect(input.getAttribute('aria-expanded')).toBe('true')
  expect(input.getAttribute('aria-controls')).toBe(list.id)
})

test('arrow keys skip unavailable options, Enter picks model and provider', async () => {
  const input = mount()
  fireEvent.focus(input)
  await screen.findByRole('option', { name: /upstage/ })
  fireEvent.keyDown(input, { key: 'ArrowDown' })
  expect(input.getAttribute('aria-activedescendant')).toBe(
    screen.getByRole('option', { name: /gpt-6.1-sol.*per 1M/ }).id,
  )
  fireEvent.keyDown(input, { key: 'ArrowDown' })
  expect(input.getAttribute('aria-activedescendant')).toBe(
    screen.getByRole('option', { name: /upstage/ }).id,
  )
  fireEvent.keyDown(input, { key: 'Enter' })
  expect(latest).toEqual({ model: 'upstage/solar-mini4:free', provider: 'nous' })
  expect(screen.queryByRole('listbox')).toBeNull()
  expect(screen.getByText('Through Nous Portal')).toBeTruthy()
})

test('clicking an available option picks it; a disabled one does nothing', async () => {
  const input = mount()
  fireEvent.focus(input)
  fireEvent.click(await screen.findByRole('option', { name: /openai\/gpt-6.1-sol/ }))
  expect(latest.model).toBe('')
  fireEvent.click(screen.getByRole('option', { name: /^gpt-6.1-sol/ }))
  expect(latest).toEqual({ model: 'gpt-6.1-sol', provider: 'openai-codex' })
})

test('a typed name that is not in the list stays with no provider; Escape closes', async () => {
  const input = mount()
  fireEvent.focus(input)
  fireEvent.change(input, { target: { value: 'my-local-model' } })
  expect(await screen.findByText(/No matching models/)).toBeTruthy()
  fireEvent.keyDown(input, { key: 'Enter' })
  expect(latest).toEqual({ model: 'my-local-model', provider: null })
  fireEvent.focus(input)
  fireEvent.keyDown(input, { key: 'ArrowDown' })
  fireEvent.keyDown(input, { key: 'Escape' })
  expect(input.getAttribute('aria-expanded')).toBe('false')
})

test('says so when the models could not be loaded and still takes free text', async () => {
  failing = true
  const input = mount()
  fireEvent.focus(input)
  expect(await screen.findByText(/Models could not be loaded/)).toBeTruthy()
  fireEvent.change(input, { target: { value: 'x' } })
  expect(latest.model).toBe('x')
})
