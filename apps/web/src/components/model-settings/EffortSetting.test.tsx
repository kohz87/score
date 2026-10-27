import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import type { ModelSettings } from '@score/contract'
import { afterEach, expect, test, vi } from 'vitest'
import { EffortSetting } from './EffortSetting.tsx'

const settings = (effort: string | null): ModelSettings => ({
  effort,
  fallbacks: [],
  fallbacksEditable: true,
  aliases: [],
  speech: {
    stt: { provider: null, model: null },
    tts: { provider: null, model: null, voice: null },
  },
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function setup(effort: string | null) {
  const puts: unknown[] = []
  vi.stubGlobal('fetch', async (_path: string, init?: RequestInit) => {
    puts.push(JSON.parse(String(init?.body)))
    return new Response(JSON.stringify(settings('high')), {
      headers: { 'Content-Type': 'application/json' },
    })
  })
  render(
    <QueryClientProvider client={new QueryClient()}>
      <EffortSetting agentId="builder" settings={settings(effort)} />
    </QueryClientProvider>,
  )
  return puts
}

test('Effort lists Default and four levels, and sends the chosen level', async () => {
  const puts = setup(null)
  const select = screen.getByRole('combobox', { name: 'Effort' }) as HTMLSelectElement
  expect([...select.options].map((option) => option.value)).toEqual([
    '',
    'low',
    'medium',
    'high',
    'xhigh',
  ])
  expect((screen.getByRole('button', { name: 'Save effort' }) as HTMLButtonElement).disabled).toBe(
    true,
  )
  fireEvent.change(select, { target: { value: 'xhigh' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save effort' }))
  await waitFor(() => expect(puts).toEqual([{ effort: 'xhigh' }]))
})

test('Default sends null; a hand-set value shows as custom and is not rewritten', async () => {
  const puts = setup('ultra')
  const select = screen.getByRole('combobox', { name: 'Effort' }) as HTMLSelectElement
  expect(select.value).toBe('ultra')
  expect(screen.getByRole('option', { name: 'Custom: ultra' })).toBeDefined()
  expect((screen.getByRole('button', { name: 'Save effort' }) as HTMLButtonElement).disabled).toBe(
    true,
  )
  fireEvent.change(select, { target: { value: '' } })
  fireEvent.click(screen.getByRole('button', { name: 'Save effort' }))
  await waitFor(() => expect(puts).toEqual([{ effort: null }]))
})
