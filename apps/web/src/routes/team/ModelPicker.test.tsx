// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { ModelPicker, modelChoices } from './ModelPicker.tsx'

const agy = {
  source: 'cli',
  models: [
    { id: 'gemini-4-argon-low', name: 'Gemini 4 Argon (Low)' },
    { id: 'gemini-4-argon-high', name: 'Gemini 4 Argon (High)' },
    { id: 'gpt-oss-120b-medium', name: 'GPT-OSS 120B (Medium)' },
  ],
}
let reply: () => Response
let asked: string[]
beforeEach(() => {
  client = new QueryClient()
  asked = []
  reply = () => Response.json(agy)
  vi.stubGlobal('fetch', async (path: string) => {
    asked.push(path)
    return reply()
  })
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

let client: QueryClient
function Harness({ start = '', runtime = 'antigravity' as const }) {
  const [value, setValue] = useState(start)
  return (
    <QueryClientProvider client={client}>
      <ModelPicker runtime={runtime} value={value} onChange={setValue} />
      <output aria-label="saved">{value}</output>
    </QueryClientProvider>
  )
}
async function picker(): Promise<HTMLSelectElement> {
  await screen.findByRole('option', { name: 'CLI default' })
  return screen.getByRole('combobox', { name: 'Model' })
}
const saved = () => screen.getByLabelText('saved').textContent

test('families with several effort levels group together; a lone model stays on its own', () => {
  const choices = modelChoices(agy.models)
  expect(choices.groups.map((group) => [group.family, group.models.length])).toEqual([
    ['Gemini 4 Argon', 2],
  ])
  expect(choices.single.map((model) => model.id)).toEqual(['gpt-oss-120b-medium'])
})

test('the list opens with CLI default, the models and Other…, and asks the server to look again', async () => {
  render(<Harness />)
  const select = await picker()
  expect(asked).toEqual(['/api/coding-agents/runtimes/antigravity/models?fresh=1'])
  const options = [...select.options].map((option) => option.text)
  expect(options[0]).toBe('CLI default')
  expect(options.at(-1)).toBe('Other…')
  expect(options).toContain('Gemini 4 Argon (High)')
  expect(select.querySelector('optgroup')?.label).toBe('Gemini 4 Argon')
  fireEvent.change(select, { target: { value: 'gemini-4-argon-high' } })
  expect(saved()).toBe('gemini-4-argon-high')
  fireEvent.change(select, { target: { value: '' } })
  expect(saved()).toBe('')
})

test('Other… shows a text field; a saved name that isn’t in the list opens as Other… with that name', async () => {
  const first = render(<Harness />)
  const select = await picker()
  fireEvent.change(select, { target: { value: '__other__' } })
  fireEvent.change(screen.getByLabelText('Model name'), { target: { value: 'my-model' } })
  expect(saved()).toBe('my-model')
  first.unmount()
  render(<Harness start="old-model-1" />)
  const again = await picker()
  expect(again.options[again.selectedIndex]!.text).toBe('Other…')
  expect((screen.getByLabelText('Model name') as HTMLInputElement).value).toBe('old-model-1')
})

test('an unreadable or empty list falls back to the plain text field', async () => {
  reply = () => Response.json({ models: [], source: 'none' })
  render(<Harness />)
  const field = await screen.findByLabelText(/Model \(optional, the CLI’s default otherwise\)/)
  expect(field.tagName).toBe('INPUT')
  fireEvent.change(field, { target: { value: 'typed' } })
  expect(saved()).toBe('typed')
})

test('a failing request also falls back to the text field', async () => {
  reply = () => new Response('{"error":{"code":"x","message":"no"}}', { status: 500 })
  render(<Harness />)
  expect((await screen.findByLabelText(/Model \(optional/)).tagName).toBe('INPUT')
})

test('the description and reasoning levels of the chosen model are shown', async () => {
  reply = () =>
    Response.json({
      source: 'cache',
      models: [
        {
          id: 'gpt-6.1-sol',
          name: 'GPT-6.1 Sol',
          description: 'Fast coding model.',
          efforts: ['low', 'high'],
        },
      ],
    })
  render(<Harness start="gpt-6.1-sol" runtime={'codex' as never} />)
  expect(await screen.findByText('Fast coding model. Reasoning levels: low, high.')).toBeDefined()
})
