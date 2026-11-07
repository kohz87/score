import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { afterEach, expect, test } from 'vitest'
import { jsonResponse, makeJob, room as teamRoom } from '../room/room-test-utils.tsx'
import {
  newer,
  older,
  renderDirect,
  resetDirectChatTest,
  stub,
} from './DirectChat-test-helpers.tsx'

afterEach(resetDirectChatTest)

test('sharing posts the reply to the chosen team job and then says it was shared', async () => {
  const posts = stub()
  renderDirect()
  fireEvent.click(
    (await screen.findAllByRole('button', { name: /^Share message from builder/ })).at(-1)!,
  )
  const menu = await screen.findByRole('dialog', { name: 'Share to the team room' })
  expect(menu.getAttribute('data-protected')).toBe('block')
  fireEvent.click(await within(menu).findByRole('button', { name: /Release notes 2\.4/ }))
  await screen.findByText('Shared to the team room')
  expect(posts.find((post) => post.url.endsWith('/share'))).toMatchObject({
    url: '/api/messages/answer/share',
    body: { jobId: 'team-job' },
  })
})

test('Escape closes the share menu and returns focus to the button that opened it', async () => {
  stub()
  renderDirect()
  const open = (await screen.findAllByRole('button', { name: /^Share message from builder/ })).at(
    -1,
  )!
  open.focus()
  fireEvent.click(open)
  await screen.findByRole('dialog', { name: 'Share to the team room' })
  fireEvent.keyDown(document.body, { key: 'Escape' })
  await waitFor(() =>
    expect(screen.queryByRole('dialog', { name: 'Share to the team room' })).toBeNull(),
  )
  expect(document.activeElement).toBe(open)
})

const docsTeam = {
  ...teamRoom,
  id: 'room-docs',
  name: 'Docs team',
  members: ['lead', 'builder'],
  everyone: false,
}
const docsJob = makeJob({ id: 'docs-job', roomId: docsTeam.id, title: 'Docs sweep' })
const twoTeams = (url: string) => {
  if (url === '/api/team-rooms')
    return jsonResponse({ asOfSeq: 1, items: [{ ...teamRoom, everyone: true }, docsTeam] })
  if (url.startsWith(`/api/rooms/${docsTeam.id}/jobs`))
    return jsonResponse({ asOfSeq: 1, items: [docsJob] })
  return undefined
}

test('with one team room the share menu shows no team choice', async () => {
  stub()
  renderDirect()
  fireEvent.click((await screen.findAllByRole('button', { name: /^Share message from/ })).at(-1)!)
  const menu = await screen.findByRole('dialog', { name: 'Share to the team room' })
  expect(within(menu).queryByRole('combobox')).toBeNull()
})

test('with two team rooms the share menu says "Share to a team" and lists the chosen team’s jobs', async () => {
  const posts = stub([newer, older], twoTeams)
  renderDirect()
  fireEvent.click((await screen.findAllByRole('button', { name: /^Share message from/ })).at(-1)!)
  const menu = await screen.findByRole('dialog', { name: 'Share to a team' })
  await within(menu).findByRole('button', { name: /Release notes 2\.4/ })
  fireEvent.change(within(menu).getByRole('combobox'), { target: { value: 'room-docs' } })
  fireEvent.click(await within(menu).findByRole('button', { name: /Docs sweep/ }))
  await screen.findByText('Shared to the team room')
  expect(posts.find((post) => post.url.endsWith('/share'))?.body).toEqual({ jobId: 'docs-job' })
})
