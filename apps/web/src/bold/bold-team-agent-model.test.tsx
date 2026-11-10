import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { open } from './bold-team-helpers.tsx'
import { snapshot } from './assigned/assigned-test-data.ts'

/** Decision 182 on the agent page: the Model row's lines, the chats list, and the warning (the jobs' models are on Tasks, decision 183). */
const settings = {
  effort: null,
  fallbacks: [],
  fallbacksEditable: true,
  aliases: [],
  speech: {
    stt: { provider: null, model: null },
    tts: { provider: null, model: null, voice: null },
  },
}
const job = (id: string, title: string, schedule: string, model: string | null) => ({
  id,
  title,
  schedule,
  description: '',
  lastRunAt: null,
  enabled: true,
  model,
})
const jobs = [
  job('r1', 'Morning summary', 'every day at 08:00', null),
  job('r2', 'Dependency check', 'Mondays at 09:00', null),
  job('r3', 'Weekly report', 'Fridays at 17:00', 'deep'),
]

type Call = { method: string; path: string; body: unknown }

function withJobs(options: { routines?: typeof jobs; pin?: number; chats?: object[] } = {}) {
  const calls: Call[] = []
  const base = vi.mocked(fetch).getMockImplementation()!
  vi.mocked(fetch).mockImplementation((input, init) => {
    const path = new URL(String(input), 'http://x').pathname
    const method = init?.method ?? 'GET'
    calls.push({ method, path, body: init?.body ? JSON.parse(String(init.body)) : null })
    if (path === '/api/agents/builder/model-settings')
      return Promise.resolve(Response.json(settings))
    if (path === '/api/agents/builder/routines' && method === 'GET')
      return Promise.resolve(Response.json({ items: options.routines ?? jobs }))
    if (path === '/api/agents/builder/assigned' && method === 'GET')
      return Promise.resolve(
        Response.json({
          agentId: 'builder',
          repeating: (options.routines ?? jobs).map((item) => ({
            ...item,
            agentId: 'builder',
            nextRunAt: null,
            provider: null,
            deliverTo: null,
          })),
          recipeSteps: [],
        }),
      )
    if (path === '/api/tasks' && method === 'GET')
      return Promise.resolve(Response.json(snapshot([])))
    if (path === '/api/agents/builder/routines/pin')
      return Promise.resolve(
        options.pin
          ? Response.json({ code: 'conflict', message: 'Hermes refused.' }, { status: options.pin })
          : Response.json({ pinned: ['r1', 'r2'] }),
      )
    if (path === '/api/agents/builder/chat-models')
      return Promise.resolve(Response.json({ agentId: 'builder', chats: options.chats ?? [] }))
    if (path === '/api/agents/builder/model' && method === 'PUT')
      return base('/api/agents/builder', undefined)
    return base(input, init)
  })
  return calls
}

async function startChange(model: string) {
  const section = await screen.findByRole('region', { name: 'Model' })
  fireEvent.click(within(section).getByRole('button', { name: 'Change the model' }))
  const form = within(section).getByRole('form', { name: 'Change model' })
  fireEvent.change(within(form).getByRole('combobox'), { target: { value: model } })
  fireEvent.click(within(form).getByRole('button', { name: 'Change model' }))
  return form
}
const puts = (calls: Call[]) =>
  calls.filter((c) => c.method === 'PUT' && c.path.endsWith('/builder/model'))
const pins = (calls: Call[]) => calls.filter((c) => c.path.endsWith('/routines/pin'))

test('the Model row says chats may set their own with /model, counts the jobs that follow, and lists the chats', async () => {
  withJobs({
    chats: [
      {
        roomId: 'r1',
        roomName: 'Ship it',
        roomKind: 'group',
        jobTitle: null,
        model: 'example-large',
        label: 'deep',
      },
    ],
  })
  open('/b/agents/builder')
  const model = await screen.findByRole('region', { name: 'Model' })
  expect(await within(model).findByText(/unless it sets its own with \/model/)).toBeDefined()
  expect(await within(model).findByText(/2 repeating jobs follow it/)).toBeDefined()
  fireEvent.click(await within(model).findByRole('button', { name: 'Set differently in 1 chat' }))
  const card = await screen.findByLabelText('Chats that override model')
  expect(within(card).getByText('deep')).toBeDefined()
  expect(within(card).getByRole('link', { name: 'Ship it' })).toBeDefined()
})

test('the Work line names the repeating jobs and opens them in Tasks; their models are set there', async () => {
  withJobs()
  open('/b/agents/builder')
  const work = await screen.findByRole('region', { name: 'Work' })
  expect(
    await within(work).findByText('Morning summary · Dependency check · Weekly report'),
  ).toBeDefined()
  expect(within(work).getByRole('link', { name: 'Open in Tasks' }).getAttribute('href')).toBe(
    '/b/tasks/repeating?agent=builder',
  )
  // The card with its per-job model lines left the agent page (decision 183): Tasks › Repeating shows them.
  expect(within(work).queryByRole('button', { name: 'Manage repeating jobs' })).toBeNull()
})

test('changing the model with jobs following it warns first, and nothing changes until a button is pressed', async () => {
  const calls = withJobs()
  open('/b/agents/builder')
  await startChange('demo/other')
  await waitFor(() => expect(document.querySelector('.bold-model-jobs-warning')).not.toBeNull())
  const panel = document.querySelector('.bold-model-jobs-warning') as HTMLElement
  expect(panel.getAttribute('data-protected')).toBe('block')
  expect(panel.getAttribute('role')).toBe('alert')
  expect(within(panel).getByText('2 repeating jobs follow builder’s model')).toBeDefined()
  expect(
    within(panel).getByText(/Morning summary \(every day at 08:00\) and Dependency check/),
  ).toBeDefined()
  expect(within(panel).getByText('Weekly report is pinned to deep and won’t change.')).toBeDefined()
  expect(within(panel).getByText('/model demo/other')).toBeDefined()
  expect(puts(calls)).toHaveLength(0)
  expect(pins(calls)).toHaveLength(0)

  fireEvent.click(within(panel).getByRole('button', { name: 'Cancel' }))
  expect(document.querySelector('.bold-model-jobs-warning')).toBeNull()
  expect(puts(calls)).toHaveLength(0)
})

test('Keep the jobs on the current model pins them, then changes the agent', async () => {
  const calls = withJobs()
  open('/b/agents/builder')
  await startChange('demo/other')
  fireEvent.click(
    await screen.findByRole('button', { name: 'Keep the jobs on demo/next-model, then change' }),
  )
  await waitFor(() => expect(puts(calls)).toHaveLength(1))
  expect(pins(calls)).toHaveLength(1)
  expect(calls.findIndex((c) => c.path.endsWith('/routines/pin'))).toBeLessThan(
    calls.findIndex((c) => c.method === 'PUT' && c.path.endsWith('/builder/model')),
  )
  expect(puts(calls)[0]!.body).toEqual({ model: 'demo/other' })
})

test('Change, jobs too changes the agent only', async () => {
  const calls = withJobs()
  open('/b/agents/builder')
  await startChange('demo/other')
  fireEvent.click(await screen.findByRole('button', { name: 'Change, jobs too' }))
  await waitFor(() => expect(puts(calls)).toHaveLength(1))
  expect(pins(calls)).toHaveLength(0)
})

test('when pinning fails it says so and changes nothing', async () => {
  const calls = withJobs({ pin: 409 })
  open('/b/agents/builder')
  await startChange('demo/other')
  fireEvent.click(await screen.findByRole('button', { name: /Keep the jobs on/ }))
  // Jobs re-read after the refusal: none were pinned here, so only the first sentence shows.
  expect(
    await screen.findByText(/Hermes refused to pin a job, so .*’s model wasn’t changed\./),
  ).toBeDefined()
  expect(puts(calls)).toHaveLength(0)
})

test('no warning when every job is pinned, or the model is the same', async () => {
  const calls = withJobs({ routines: [job('r3', 'Weekly report', 'Fridays at 17:00', 'deep')] })
  open('/b/agents/builder')
  await startChange('demo/other')
  await waitFor(() => expect(puts(calls)).toHaveLength(1))
  expect(document.querySelector('.bold-model-jobs-warning')).toBeNull()
})
