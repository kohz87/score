import { cleanup, screen, within } from '@testing-library/react'
import { expect, test } from 'vitest'
import { disposers, open, teamState } from './bold-team-helpers.tsx'

test('Team cards show state, a Watch glimpse, Message and a way to open the agent', async () => {
  open('/b/agents')
  expect(await screen.findByRole('heading', { name: 'Agents' })).toBeDefined()
  expect(screen.getByRole('button', { name: 'Pause everyone' })).toBeDefined()

  const card = (await screen.findByRole('link', { name: 'builder' })).closest('article')!
  expect(within(card).getByText('Working · Adding feed pagination')).toBeDefined()
  expect(within(card).getByRole('img', { name: /builder.s screen: editor/ })).toBeDefined()
  expect(within(card).getByRole('link', { name: 'Message' }).getAttribute('href')).toBe(
    '/b?with=builder',
  )
  expect(within(card).getByRole('link', { name: 'Open' }).getAttribute('href')).toBe(
    '/b/agents/builder',
  )

  const coderCard = screen.getByRole('link', { name: 'coder' }).closest('article')!
  expect(within(coderCard).queryByRole('img', { name: /coder.s screen/ })).toBeNull()
  expect(within(coderCard).getByText('Codex')).toBeDefined()
})

test('Team says so when there are no agents and when the list cannot load', async () => {
  teamState.agentsReply = () => Response.json({ asOfSeq: 1, items: [] })
  teamState.watchReply = () => Response.json({ items: [] })
  open('/b/agents')
  expect(await screen.findByText('No agents yet')).toBeDefined()
  cleanup()
  disposers.splice(0).forEach((dispose) => dispose())

  teamState.agentsReply = () =>
    Response.json({ error: { code: 'unavailable', message: 'no' } }, { status: 500 })
  open('/b/agents')
  const alert = await screen.findByRole('alert')
  expect(within(alert).getByText('Couldn’t load the team')).toBeDefined()
  expect(within(alert).getByRole('button', { name: 'Try again' })).toBeDefined()
})
