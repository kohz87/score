import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { deleteOp, deletePreview, open, stubDelete } from './bold-team-helpers.tsx'

test('Remove agent… shows the preview in place; blockers and the typed name gate Remove', async () => {
  const calls = stubDelete((call) =>
    call.url === '/api/agents/preview'
      ? Response.json(deletePreview(['builder is mid-run on a shared file']))
      : null,
  )
  const { router } = open('/b/agents/builder')
  fireEvent.click(await screen.findByRole('button', { name: 'Remove agent…' }))
  const panel = await screen.findByRole('group', { name: 'Remove builder' })
  expect(panel.getAttribute('data-protected')).toBe('block')
  expect(await within(panel).findByText(/1 active runs · 2 queued messages/)).toBeDefined()
  expect(within(panel).getByText(/4 unfinished assignments/)).toBeDefined()
  expect(within(panel).getByText('Its unfinished work goes back to the lead.')).toBeDefined()
  expect(within(panel).getByText(/A private copy is kept first:/)).toBeDefined()
  expect(within(panel).getByText('/home/user/.score/exports/builder.tar')).toBeDefined()
  expect(within(panel).getByText(/isn’t a full undo/)).toBeDefined()
  expect(within(panel).getByRole('alert').textContent).toBe('builder is mid-run on a shared file')
  const input = within(panel).getByLabelText('Type builder to confirm')
  fireEvent.change(input, { target: { value: 'builder' } })
  expect(
    (within(panel).getByRole('button', { name: 'Remove' }) as HTMLButtonElement).disabled,
  ).toBe(true)
  expect(calls.some((call) => call.method === 'DELETE')).toBe(false)
  expect(router.state.location.pathname).toBe('/b/agents/builder')
})

test('typing the name enables Remove; DELETE carries the name, the preview hash and an Idempotency-Key, then it goes to Team', async () => {
  let polls = 0
  const calls = stubDelete((call) => {
    if (call.url === '/api/agents/preview') return Response.json(deletePreview())
    if (call.method === 'DELETE') return Response.json(deleteOp('running'), { status: 202 })
    polls += 1
    return Response.json(deleteOp(polls > 1 ? 'completed' : 'running'))
  })
  const { router } = open('/b/agents/builder')
  fireEvent.click(await screen.findByRole('button', { name: 'Remove agent…' }))
  const panel = await screen.findByRole('group', { name: 'Remove builder' })
  const input = await within(panel).findByLabelText('Type builder to confirm')
  const remove = within(panel).getByRole('button', { name: 'Remove' }) as HTMLButtonElement
  expect(remove.disabled).toBe(true)
  fireEvent.change(input, { target: { value: 'builde' } })
  expect(remove.disabled).toBe(true)
  fireEvent.change(input, { target: { value: 'builder' } })
  expect(remove.disabled).toBe(false)
  fireEvent.click(remove)
  await waitFor(() => expect(router.state.location.pathname).toBe('/b/agents'))
  const del = calls.find((call) => call.method === 'DELETE')!
  expect(del.body).toEqual({ typedName: 'builder', previewHash: 'b'.repeat(64) })
  expect(Object.keys(del.headers).map((key) => key.toLowerCase())).toContain('idempotency-key')
})

test('a Hermes agent the server refuses to remove shows the server message and stays', async () => {
  stubDelete((call) => {
    if (call.url === '/api/agents/preview') return Response.json(deletePreview())
    if (call.method === 'DELETE')
      return Response.json(
        { error: { code: 'agent_busy', message: 'builder started a run a moment ago.' } },
        { status: 409 },
      )
    return null
  })
  const { router } = open('/b/agents/builder')
  fireEvent.click(await screen.findByRole('button', { name: 'Remove agent…' }))
  const panel = await screen.findByRole('group', { name: 'Remove builder' })
  fireEvent.change(await within(panel).findByLabelText('Type builder to confirm'), {
    target: { value: 'builder' },
  })
  fireEvent.click(within(panel).getByRole('button', { name: 'Remove' }))
  expect((await within(panel).findByRole('alert')).textContent).toContain(
    'builder started a run a moment ago.',
  )
  expect(router.state.location.pathname).toBe('/b/agents/builder')
})

test('Cancel and Escape close the panel and put focus back on Remove agent…', async () => {
  stubDelete((call) => (call.url === '/api/agents/preview' ? Response.json(deletePreview()) : null))
  open('/b/agents/builder')
  fireEvent.click(await screen.findByRole('button', { name: 'Remove agent…' }))
  let panel = await screen.findByRole('group', { name: 'Remove builder' })
  const cancel = within(panel).getByRole('button', { name: 'Cancel' })
  await waitFor(() => expect(document.activeElement).toBe(cancel))
  fireEvent.click(cancel)
  expect(screen.queryByRole('group', { name: 'Remove builder' })).toBeNull()
  await waitFor(() =>
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Remove agent…' })),
  )
  fireEvent.click(screen.getByRole('button', { name: 'Remove agent…' }))
  panel = await screen.findByRole('group', { name: 'Remove builder' })
  fireEvent.keyDown(within(panel).getByRole('button', { name: 'Cancel' }), { key: 'Escape' })
  expect(screen.queryByRole('group', { name: 'Remove builder' })).toBeNull()
  await waitFor(() =>
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Remove agent…' })),
  )
})

test('Remove agent… on a coding agent asks in plain words, with no preview, and removes it', async () => {
  const calls = stubDelete((call) =>
    call.method === 'DELETE' ? new Response(null, { status: 204 }) : null,
  )
  const { router } = open('/b/agents/coder')
  fireEvent.click(await screen.findByRole('button', { name: 'Remove agent…' }))
  const panel = await screen.findByRole('group', { name: 'Remove coder' })
  expect(panel.getAttribute('data-protected')).toBe('block')
  expect(
    within(panel).getByText('Removes coder from the team. Past work stays in rooms.'),
  ).toBeDefined()
  expect(calls.some((call) => call.url === '/api/agents/preview')).toBe(false)
  expect(document.getElementById('agent-more')).toBeNull()
  fireEvent.click(within(panel).getByRole('button', { name: 'Remove' }))
  await waitFor(() => expect(router.state.location.pathname).toBe('/b/agents'))
  expect(calls.find((call) => call.method === 'DELETE')!.url).toBe('/api/coding-agents/coder')
})

test('a busy coding agent shows the server message and stays', async () => {
  stubDelete((call) =>
    call.method === 'DELETE'
      ? Response.json(
          { error: { code: 'agent_busy', message: 'coder is working on a job.' } },
          { status: 409 },
        )
      : null,
  )
  const { router } = open('/b/agents/coder')
  fireEvent.click(await screen.findByRole('button', { name: 'Remove agent…' }))
  const panel = await screen.findByRole('group', { name: 'Remove coder' })
  fireEvent.click(within(panel).getByRole('button', { name: 'Remove' }))
  expect((await within(panel).findByRole('alert')).textContent).toContain(
    'coder is working on a job.',
  )
  expect(router.state.location.pathname).toBe('/b/agents/coder')
})

test('the default agent has no Remove agent… action', async () => {
  open('/b/agents/default')
  expect(await screen.findByRole('heading', { level: 1 })).toBeDefined()
  expect(screen.queryByRole('button', { name: 'Remove agent…' })).toBeNull()
})

test('after a refused DELETE the preview reloads, the message stays, and a second attempt succeeds', async () => {
  let deletes = 0
  let previews = 0
  const calls = stubDelete((call) => {
    if (call.url === '/api/agents/preview') {
      previews += 1
      return Response.json(deletePreview())
    }
    if (call.method === 'DELETE') {
      deletes += 1
      return deletes === 1
        ? Response.json(
            { error: { code: 'preview_stale', message: 'builder changed. Review again.' } },
            { status: 409 },
          )
        : Response.json(deleteOp('completed'), { status: 202 })
    }
    return Response.json(deleteOp('completed'))
  })
  const { router } = open('/b/agents/builder')
  fireEvent.click(await screen.findByRole('button', { name: 'Remove agent…' }))
  const panel = await screen.findByRole('group', { name: 'Remove builder' })
  fireEvent.change(await within(panel).findByLabelText('Type builder to confirm'), {
    target: { value: 'builder' },
  })
  fireEvent.click(within(panel).getByRole('button', { name: 'Remove' }))
  await waitFor(() => expect(previews).toBe(2))
  const input = await within(panel).findByLabelText('Type builder to confirm')
  expect((input as HTMLInputElement).value).toBe('')
  expect(within(panel).getByRole('alert').textContent).toContain('builder changed. Review again.')
  fireEvent.change(input, { target: { value: 'builder' } })
  fireEvent.click(within(panel).getByRole('button', { name: 'Remove' }))
  await waitFor(() => expect(router.state.location.pathname).toBe('/b/agents'))
  expect(calls.filter((call) => call.method === 'DELETE')).toHaveLength(2)
})

test('while a DELETE is pending Cancel is disabled and Escape does nothing', async () => {
  let release: () => void = () => {}
  const held = new Promise<void>((resolve) => (release = resolve))
  const inner = globalThis.fetch
  stubDelete((call) => (call.url === '/api/agents/preview' ? Response.json(deletePreview()) : null))
  const wrapped = globalThis.fetch
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
      init?.method === 'DELETE'
        ? held.then(() => new Response(null, { status: 204 }))
        : wrapped(input, init),
    ),
  )
  void inner
  open('/b/agents/coder')
  fireEvent.click(await screen.findByRole('button', { name: 'Remove agent…' }))
  const panel = await screen.findByRole('group', { name: 'Remove coder' })
  fireEvent.click(within(panel).getByRole('button', { name: 'Remove' }))
  await waitFor(() =>
    expect(
      (within(panel).getByRole('button', { name: 'Cancel' }) as HTMLButtonElement).disabled,
    ).toBe(true),
  )
  fireEvent.keyDown(within(panel).getByRole('button', { name: 'Cancel' }), { key: 'Escape' })
  expect(screen.getByRole('group', { name: 'Remove coder' })).toBeDefined()
  release()
})

test('a coding agent removal that finishes after the panel is gone does not navigate', async () => {
  let release: () => void = () => {}
  const held = new Promise<void>((resolve) => (release = resolve))
  const wrapped = globalThis.fetch
  vi.stubGlobal(
    'fetch',
    vi.fn((input: RequestInfo | URL, init?: RequestInit) =>
      init?.method === 'DELETE'
        ? held.then(() => new Response(null, { status: 204 }))
        : wrapped(input, init),
    ),
  )
  const { router } = open('/b/agents/coder')
  fireEvent.click(await screen.findByRole('button', { name: 'Remove agent…' }))
  const panel = await screen.findByRole('group', { name: 'Remove coder' })
  fireEvent.click(within(panel).getByRole('button', { name: 'Remove' }))
  await router.navigate('/b/agents/builder')
  await waitFor(() => expect(screen.queryByRole('group', { name: 'Remove coder' })).toBeNull())
  release()
  await new Promise((resolve) => setTimeout(resolve, 50))
  expect(router.state.location.pathname).toBe('/b/agents/builder')
})

test('an operation that needs attention keeps the page, shows Close, and Escape closes it', async () => {
  stubDelete((call) => {
    if (call.url === '/api/agents/preview') return Response.json(deletePreview())
    if (call.method === 'DELETE') return Response.json(deleteOp('running'), { status: 202 })
    return Response.json({
      ...deleteOp('running'),
      state: 'needs_attention',
      error: 'Hermes did not answer.',
    })
  })
  const { router } = open('/b/agents/builder')
  fireEvent.click(await screen.findByRole('button', { name: 'Remove agent…' }))
  const panel = await screen.findByRole('group', { name: 'Remove builder' })
  fireEvent.change(await within(panel).findByLabelText('Type builder to confirm'), {
    target: { value: 'builder' },
  })
  fireEvent.click(within(panel).getByRole('button', { name: 'Remove' }))
  const close = await within(panel).findByRole('button', { name: 'Close' })
  await waitFor(() => expect(document.activeElement).toBe(close))
  expect(within(panel).getByText('Hermes did not answer.')).toBeDefined()
  expect(router.state.location.pathname).toBe('/b/agents/builder')
  fireEvent.keyDown(close, { key: 'Escape' })
  expect(screen.queryByRole('group', { name: 'Remove builder' })).toBeNull()
})

test('a capitalised or padded name still confirms, and DELETE carries the exact name (3.7.1)', async () => {
  const calls = stubDelete((call) => {
    if (call.url === '/api/agents/preview')
      return Response.json({
        ...deletePreview(),
        pendingWork: {
          ...deletePreview().pendingWork,
          activeRuns: 0,
          queuedTurns: 0,
          pendingApprovals: 0,
          assignments: 0,
        },
      })
    if (call.method === 'DELETE') return Response.json(deleteOp('running'), { status: 202 })
    return null
  })
  open('/b/agents/builder')
  fireEvent.click(await screen.findByRole('button', { name: 'Remove agent…' }))
  const panel = await screen.findByRole('group', { name: 'Remove builder' })
  const input = await within(panel).findByLabelText('Type builder to confirm')
  expect(input.getAttribute('autocapitalize')).toBe('none')
  fireEvent.change(input, { target: { value: 'Builde' } })
  expect(within(panel).getByText('That doesn’t match builder.')).toBeDefined()
  fireEvent.change(input, { target: { value: ' Builder ' } })
  const remove = within(panel).getByRole('button', { name: 'Remove' }) as HTMLButtonElement
  expect(remove.disabled).toBe(false)
  fireEvent.click(remove)
  await waitFor(() => expect(calls.some((call) => call.method === 'DELETE')).toBe(true))
  expect(calls.find((call) => call.method === 'DELETE')!.body).toMatchObject({
    typedName: 'builder',
  })
})

test('Stop its work stops a stuck agent and checks again until the work is gone (3.7.1)', async () => {
  let stopped = false
  const calls = stubDelete((call) => {
    if (call.url === '/api/agents/builder/stop-work') {
      stopped = true
      return Response.json({ ok: true })
    }
    if (call.url === '/api/agents/preview')
      return Response.json(
        stopped
          ? {
              ...deletePreview(),
              pendingWork: {
                ...deletePreview().pendingWork,
                activeRuns: 0,
                queuedTurns: 0,
                pendingApprovals: 0,
                assignments: 0,
              },
            }
          : {
              ...deletePreview([
                'Finish active runs, queued turns, pending approvals and unfinished assignments before deleting.',
              ]),
              pendingWork: { ...deletePreview().pendingWork, pendingApprovals: 0, assignments: 0 },
            },
      )
    return null
  })
  open('/b/agents/builder')
  fireEvent.click(await screen.findByRole('button', { name: 'Remove agent…' }))
  const panel = await screen.findByRole('group', { name: 'Remove builder' })
  fireEvent.click(await within(panel).findByRole('button', { name: 'Stop builder’s work' }))
  await waitFor(() =>
    expect(calls.some((call) => call.url === '/api/agents/builder/stop-work')).toBe(true),
  )
  expect(
    calls.find((call) => call.url === '/api/agents/builder/stop-work')!.headers['idempotency-key'],
  ).toBeTruthy()
  await waitFor(() =>
    expect(
      within(panel).queryByRole('button', { name: /Stop builder’s work|Stopping/ }),
    ).toBeNull(),
  )
  expect(within(panel).queryByRole('alert')).toBeNull()
})
