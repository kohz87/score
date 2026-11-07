import { fireEvent, screen, waitFor } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { builder } from './bold-team-fixtures.ts'
import { open, teamState, withLifecycle } from './bold-team-helpers.tsx'

test('a pause that fails still offers the same action again', async () => {
  let attempts = 0
  teamState.pauseReply = () =>
    ++attempts === 1
      ? Response.json(
          { error: { code: 'hermes_unavailable', message: 'Some tasks couldn’t be held.' } },
          { status: 502 },
        )
      : Response.json(builder)
  open('/b/agents/builder')
  fireEvent.click(await screen.findByRole('button', { name: 'Pause builder' }))
  const retry = await screen.findByRole('button', { name: 'Pause again builder' })
  fireEvent.click(retry)
  await waitFor(() => {
    const calls = vi
      .mocked(fetch)
      .mock.calls.filter(([input]) => String(input).endsWith('/api/agents/builder/pause'))
    expect(calls).toHaveLength(2)
  })
})

test.each([
  ['setting_up', false, false],
  ['deleting', false, false],
  ['needs_attention', true, false],
  ['ready', true, true],
] as const)('a %s agent: Remove agent… shown %s, Pause shown %s', async (state, remove, pause) => {
  withLifecycle(state)
  open('/b/agents/builder')
  await screen.findByRole('heading', { name: 'builder', level: 1 })
  if (state !== 'ready') await screen.findByLabelText('builder status')
  expect(screen.queryByRole('button', { name: 'Remove agent…' }) !== null).toBe(remove)
  expect(screen.queryByRole('button', { name: /^(Pause|Resume) builder/u }) !== null).toBe(pause)
})

test('a ready agent with a pause recorded offers Resume', async () => {
  withLifecycle('ready', 'paused')
  open('/b/agents/builder')
  expect(await screen.findByRole('button', { name: 'Resume builder' })).toBeDefined()
})

test('opening a removed agent’s page directly stays on it, with its history and no Pause or Remove', async () => {
  withLifecycle('removed')
  const { router } = open('/b/agents/builder')
  await screen.findByRole('heading', { name: 'builder', level: 1 })
  await new Promise((resolve) => setTimeout(resolve, 50))
  expect(router.state.location.pathname).toBe('/b/agents/builder')
  expect(screen.queryByRole('button', { name: 'Remove agent…' })).toBeNull()
  expect(screen.queryByRole('button', { name: /^(Pause|Resume) builder/u })).toBeNull() // 3.5.1: no one-to-one to start with an agent that has left.
  expect(screen.queryByRole('link', { name: 'Message' })).toBeNull()
})

test('a page that saw the agent go from deleting to removed leaves for Team', async () => {
  // The fenced list only changes on stream events; this page reads the detail when the list lacks the agent.
  withLifecycle('deleting')
  teamState.agentsReply = () => Response.json({ asOfSeq: 1, items: [] })
  const { router, queryClient } = open('/b/agents/builder')
  await screen.findByLabelText('builder status')
  withLifecycle('removed')
  teamState.agentsReply = () => Response.json({ asOfSeq: 1, items: [] })
  void queryClient.invalidateQueries({ queryKey: ['team', 'detail', 'builder'] })
  await waitFor(() => expect(router.state.location.pathname).toBe('/b/agents'))
})
