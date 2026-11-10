// Decision 183: a model and an effort per step, set in the step's settings and saved into the definition.
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { expect, test } from 'vitest'
import { setUpRecipeTests } from './BoldRecipes-helpers.tsx'

const { json, mount, onRequest, requests, saveButton, showText } = setUpRecipeTests()

const answers = (url: string) => {
  if (url.endsWith('/model-settings'))
    return json({
      effort: null,
      fallbacks: [],
      fallbacksEditable: true,
      speech: {
        stt: { provider: null, model: null },
        tts: { provider: null, model: null, voice: null },
      },
      aliases: [{ name: 'fast', model: 'gpt-fast', provider: 'openai', editable: true }],
    })
  if (url.startsWith('/api/models?'))
    return json({
      items: [
        {
          provider: 'anthropic',
          providerLabel: 'Anthropic',
          model: 'sonnet',
          available: true,
          reason: null,
          free: false,
          price: null,
        },
      ],
    })
  if (url.endsWith('/efforts'))
    return json({
      agentId: url.split('/')[3],
      own: null,
      levels: ['low', 'medium', 'high'],
      chats: [],
    })
  return undefined
}

async function openDraftStep() {
  const steps = await showText()
  fireEvent.click(within(steps).getByRole('button', { name: /^1.*Draft the notes/ }))
  return steps
}

const savedDefinition = () => {
  const saved = requests.find((request) => request.url === '/api/workflows/wf-release/versions')!
  return JSON.parse(String(saved.init?.body)) as {
    definition: { nodes: { id: string; model?: unknown; effort?: unknown }[] }
  }
}

test('a step has its own model and effort: the pills say "its own" until one is set, then amber', async () => {
  onRequest(answers)
  mount()
  const steps = await openDraftStep()
  expect(
    within(steps).getByRole('button', { name: 'Model for step 1: its own. Change' }),
  ).toBeDefined()
  expect(
    within(steps).getByRole('button', { name: 'Effort for step 1: its own. Change' }),
  ).toBeDefined()

  const model = await screen.findByRole('combobox', { name: 'Model' })
  await waitFor(() => expect(within(model).getByRole('option', { name: /^fast/ })).toBeDefined())
  fireEvent.change(model, { target: { value: '\u0000fast' } })
  fireEvent.change(screen.getByRole('combobox', { name: 'Effort' }), { target: { value: 'low' } })

  const modelPill = within(steps).getByRole('button', { name: 'Model for step 1: fast. Change' })
  expect(modelPill.className).toContain('bold-pin--set')
  expect(
    within(steps).getByRole('button', { name: 'Effort for step 1: low. Change' }).className,
  ).toContain('bold-pin--set')
  // The step after it still follows its agent.
  expect(
    within(steps).getByRole('button', { name: 'Model for step 2: its own. Change' }),
  ).toBeDefined()
})

test('a model from the list keeps its provider; saving writes both into the definition', async () => {
  onRequest(answers)
  mount()
  await openDraftStep()
  const model = await screen.findByRole('combobox', { name: 'Model' })
  await waitFor(() => expect(within(model).getByRole('option', { name: /^sonnet/ })).toBeDefined())
  fireEvent.change(model, { target: { value: 'anthropic\u0000sonnet' } })
  fireEvent.change(screen.getByRole('combobox', { name: 'Effort' }), { target: { value: 'high' } })
  await waitFor(() => expect(saveButton().disabled).toBe(false))
  fireEvent.click(saveButton())
  await waitFor(() =>
    expect(requests.some((request) => request.url === '/api/workflows/wf-release/versions')).toBe(
      true,
    ),
  )
  const draft = savedDefinition().definition.nodes.find((node) => node.id === 'draft')!
  expect(draft.model).toEqual({ model: 'sonnet', provider: 'anthropic' })
  expect(draft.effort).toBe('high')
  // An alias carries no provider; a step left alone has no keys at all.
  expect(
    savedDefinition().definition.nodes.find((node) => node.id === 'review'),
  ).not.toHaveProperty('model')
})

test('choosing "Its own" again removes the keys from the saved definition', async () => {
  onRequest(answers)
  mount()
  await openDraftStep()
  const model = await screen.findByRole('combobox', { name: 'Model' })
  await waitFor(() => expect(within(model).getByRole('option', { name: /^fast/ })).toBeDefined())
  fireEvent.change(model, { target: { value: '\u0000fast' } })
  const effort = screen.getByRole('combobox', { name: 'Effort' })
  fireEvent.change(effort, { target: { value: 'low' } })
  fireEvent.change(model, { target: { value: '' } })
  fireEvent.change(effort, { target: { value: '' } })
  expect(
    await screen.findByRole('button', { name: 'Model for step 1: its own. Change' }),
  ).toBeDefined()
  fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), {
    target: { value: 'Draft it' },
  })
  await waitFor(() => expect(saveButton().disabled).toBe(false))
  fireEvent.click(saveButton())
  await waitFor(() =>
    expect(requests.some((request) => request.url === '/api/workflows/wf-release/versions')).toBe(
      true,
    ),
  )
  const draft = savedDefinition().definition.nodes.find((node) => node.id === 'draft')!
  expect(draft).not.toHaveProperty('model')
  expect(draft).not.toHaveProperty('effort')
})
