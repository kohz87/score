import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { agents, jsonResponse, makeJob, renderInRoom } from './room-test-utils.tsx'
import { BoldTeamRoom } from './BoldTeamRoom.tsx'
import { setupRoomTest, stubRoom } from './BoldTeamRoom-helpers.tsx'

setupRoomTest()

/** Decision 182 in a group: `@reviewer /model …` opens reviewer's model choices; a pick sets this chat's model only. */
const settings = {
  effort: null,
  fallbacks: [],
  fallbacksEditable: true,
  aliases: [
    { name: 'fast', model: 'example-small', provider: 'demo', editable: true },
    { name: 'deep', model: 'example-large', provider: 'demo', editable: true },
  ],
  speech: {
    stt: { provider: null, model: null },
    tts: { provider: null, model: null, voice: null },
  },
}
const option = (model: string, over: object = {}) => ({
  provider: 'demo',
  providerLabel: 'Demo',
  model,
  available: true,
  reason: null,
  free: false,
  price: null,
  ...over,
})
const catalog = ['example-model', 'example-large', 'free-model', 'm4', 'm5', 'm6', 'm7', 'm8'].map(
  (model) => option(model, model === 'free-model' ? { free: true } : {}),
)

type Call = { url: string; method: string; body: unknown }

function stubModels(base: ReturnType<typeof stubRoom>, chat: object[] = []) {
  const calls: Call[] = []
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = String(input)
      const method = init?.method ?? 'GET'
      calls.push({ url, method, body: init?.body ? JSON.parse(String(init.body)) : null })
      if (method === 'PUT' && url.endsWith('/rooms/room-1/models/reviewer')) {
        const model = (JSON.parse(String(init?.body)) as { model: string | null }).model
        return jsonResponse({
          roomId: 'room-1',
          agentId: 'reviewer',
          current: model
            ? {
                roomId: 'room-1',
                agentId: 'reviewer',
                model: 'example-large',
                provider: 'demo',
                label: model,
              }
            : null,
          replaced: {
            roomId: 'room-1',
            agentId: 'reviewer',
            model: 'free-model',
            provider: null,
            label: 'free-model',
          },
        })
      }
      if (url.endsWith('/rooms/room-1/models')) return jsonResponse({ asOfSeq: 0, items: chat })
      if (url.endsWith('/agents/reviewer/model-settings')) return jsonResponse(settings)
      if (url.includes('/api/models?')) {
        const q = new URL(url, 'http://x').searchParams.get('q') ?? ''
        return jsonResponse({ items: catalog.filter((item) => item.model.includes(q)) })
      }
      if (url.endsWith('/agents/reviewer/efforts'))
        return jsonResponse({
          agentId: 'reviewer',
          own: 'medium',
          levels: ['low', 'high'],
          chats: [],
        })
      return base(input, init)
    }),
  )
  return calls
}

async function openComposer(text: string) {
  const composer = await screen.findByRole('combobox', { name: /^Message Team room/ })
  fireEvent.change(composer, { target: { value: text } })
  return composer as HTMLTextAreaElement
}

test('@reviewer /mo lists aliases, a few models with a count, then Back to its own', async () => {
  const base = stubRoom([makeJob({ id: 'job-1', title: 'Activity feed' })])
  stubModels(base)
  renderInRoom(<BoldTeamRoom agents={agents} />, ['/b'])
  await openComposer('@reviewer /mo')
  const list = await screen.findByRole('listbox', { name: 'Commands' })
  expect(
    within(list).getByText(/Model for reviewer in this chat · its own is fake-model/),
  ).toBeTruthy()
  expect(within(list).getByText('ALIASES')).toBeTruthy()
  expect(within(list).getByText('/model fast')).toBeTruthy()
  expect(within(list).getByText('example-small · Demo')).toBeTruthy()
  expect(within(list).getByText('MODELS IT CAN USE · type to search')).toBeTruthy()
  expect(within(list).getByText('+ 3 more: keep typing to narrow')).toBeTruthy()
  expect(within(list).getByText('/model default')).toBeTruthy()
  expect(within(list).getByText('Back to reviewer’s own (fake-model)')).toBeTruthy()
})

test('what follows /model narrows the models', async () => {
  const base = stubRoom([makeJob({ id: 'job-1', title: 'Activity feed' })])
  const calls = stubModels(base)
  renderInRoom(<BoldTeamRoom agents={agents} />, ['/b'])
  await openComposer('@reviewer /model free')
  const list = await screen.findByRole('listbox', { name: 'Commands' })
  await within(list).findByText('/model free-model')
  expect(within(list).queryByText('/model m4')).toBeNull()
  expect(
    calls.some((call) => call.url.includes('q=free') && call.url.includes('agentId=reviewer')),
  ).toBe(true)
})

test('picking deep and sending sets this chat only, says so with Undo, and never touches the agent’s own model', async () => {
  const base = stubRoom([makeJob({ id: 'job-1', title: 'Activity feed' })])
  const calls = stubModels(base)
  renderInRoom(<BoldTeamRoom agents={agents} />, ['/b'])
  const composer = await openComposer('@reviewer /model ')
  const list = await screen.findByRole('listbox', { name: 'Commands' })
  fireEvent.click(await within(list).findByText('/model deep'))
  expect(composer.value).toBe('@reviewer /model deep ')
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
  expect(
    await screen.findByText('You set reviewer’s model to deep (example-large) for this chat'),
  ).toBeDefined()
  const put = calls.find((call) => call.method === 'PUT' && call.url.endsWith('/models/reviewer'))!
  expect(put.body).toEqual({ model: 'deep' })
  expect(
    calls.some((call) => call.method === 'PUT' && /\/agents\/reviewer\/model$/.test(call.url)),
  ).toBe(false)
  expect(
    base.mock.calls.some(
      ([url, init]) => String(url).includes('/messages') && init?.method === 'POST',
    ),
  ).toBe(false)

  // Undo puts back what the change replaced.
  fireEvent.click(screen.getByRole('button', { name: 'Undo' }))
  await waitFor(() =>
    expect(
      calls.filter((call) => call.method === 'PUT' && call.url.endsWith('/models/reviewer')),
    ).toHaveLength(2),
  )
  const back = calls.filter(
    (call) => call.method === 'PUT' && call.url.endsWith('/models/reviewer'),
  )[1]!
  expect(back.body).toEqual({ model: 'free-model', label: 'free-model' }) // exactly what was replaced, never the alias name again
})

test('/model default goes back to the agent’s own', async () => {
  const base = stubRoom([makeJob({ id: 'job-1', title: 'Activity feed' })])
  const calls = stubModels(base, [
    {
      roomId: 'room-1',
      agentId: 'reviewer',
      model: 'example-large',
      provider: 'demo',
      label: 'deep',
    },
  ])
  renderInRoom(<BoldTeamRoom agents={agents} />, ['/b'])
  await openComposer('@reviewer /model default')
  fireEvent.click(screen.getByRole('button', { name: 'Send' }))
  expect(
    await screen.findByText(/reviewer is back on its own model in this chat \(fake-model\)/),
  ).toBeDefined()
  expect(calls.find((call) => call.method === 'PUT')!.body).toEqual({ model: null })
})
