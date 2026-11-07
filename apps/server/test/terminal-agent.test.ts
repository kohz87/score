import { TerminalTicketSchema } from '@score/contract'
import { expect, test } from 'vitest'
import { HttpError } from '../src/errors.ts'
import { connect, headers, makeApp, pair, reader, rejected } from './terminal-helpers.ts'

test('a live session: a ticket naming an agent runs its CLI instead of the shell, and the list says whose (3.11.0)', async () => {
  const runs: string[] = []
  const { app, home } = makeApp({}, undefined, {
    agentRun: async (agentId) => {
      runs.push(agentId)
      if (agentId !== 'builder') throw new HttpError(404, 'not_found', 'Couldn’t find that agent.')
      return { file: '/bin/sh', args: ['-c', 'echo agent-live-$((40+2)); sleep 30'], cwd: home }
    },
  })
  const cookie = await pair(app)
  // An unknown agent is refused before the password check is used up.
  app.pairing.markFresh(cookie)
  const unknown = await app.inject({
    method: 'POST',
    url: '/api/terminal/tickets',
    headers: { ...headers, cookie },
    payload: { agent: 'nobody' },
  })
  expect(unknown.statusCode).toBe(404)
  const minted = await app.inject({
    method: 'POST',
    url: '/api/terminal/tickets',
    headers: { ...headers, cookie },
    payload: { agent: 'builder' },
  })
  expect(minted.statusCode, minted.body).toBe(200)
  const socket = await connect(app, TerminalTicketSchema.parse(minted.json()).ticket, cookie)
  await reader(socket).until('agent-live-42')
  // Checked when the ticket was minted and again when the terminal opened.
  expect(runs).toEqual(['nobody', 'builder', 'builder'])
  const sessions = await app.inject({
    url: '/api/terminal/sessions',
    headers: { ...headers, cookie },
  })
  expect(sessions.json().items).toEqual([expect.objectContaining({ agent: 'builder' })])
  socket.terminate()
})

test('without a live-session resolver a ticket naming an agent is refused; an odd agent name is a bad request', async () => {
  const { app } = makeApp()
  const cookie = await pair(app)
  app.pairing.markFresh(cookie)
  const named = await app.inject({
    method: 'POST',
    url: '/api/terminal/tickets',
    headers: { ...headers, cookie },
    payload: { agent: 'builder' },
  })
  expect(named.statusCode).toBe(404)
  const odd = await app.inject({
    method: 'POST',
    url: '/api/terminal/tickets',
    headers: { ...headers, cookie },
    payload: { agent: '../etc' },
  })
  expect(odd.statusCode).toBe(400)
})

test('an agent that became unavailable after its ticket was minted opens nothing, and the ticket is used up (3.11.0)', async () => {
  let available = true
  const { app, home } = makeApp({}, undefined, {
    agentRun: async () => {
      if (!available) throw new Error('workspace gone')
      return { file: '/bin/sh', args: ['-c', 'sleep 30'], cwd: home }
    },
  })
  const cookie = await pair(app)
  app.pairing.markFresh(cookie)
  const minted = await app.inject({
    method: 'POST',
    url: '/api/terminal/tickets',
    headers: { ...headers, cookie },
    payload: { agent: 'builder' },
  })
  expect(minted.statusCode).toBe(200)
  const ticket = TerminalTicketSchema.parse(minted.json()).ticket
  available = false
  // A clear refusal before the upgrade (409), not a server error.
  await expect(connect(app, ticket, cookie)).rejects.toThrow(/response: 409/)
  const sessions = await app.inject({
    url: '/api/terminal/sessions',
    headers: { ...headers, cookie },
  })
  expect(sessions.json().items).toEqual([])
  available = true
  await rejected(connect(app, ticket, cookie))
})
