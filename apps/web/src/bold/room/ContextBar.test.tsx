import { screen } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import {
  agents,
  disposeRoomTest,
  jsonResponse,
  makeJob,
  mockFetch,
  renderInRoom,
} from './room-test-utils.tsx'
import { ContextBar } from './ContextBar.tsx'

afterEach(() => {
  disposeRoomTest()
  vi.unstubAllGlobals()
})

const emptySession: {
  window: number | null
  used: number | null
  measuredAt: string | null
  model: string | null
  source: null
  parts: null
  autoCompactAt: number | null
  compactions: number
  asOfSeq: number
} = {
  window: null,
  used: null,
  measuredAt: null,
  model: null,
  source: null,
  parts: null,
  autoCompactAt: null,
  compactions: 0,
  asOfSeq: 0,
}

/** The agent read gives the model; the session read (per session id) gives the meter. */
function stubContext(body: unknown, sessions: Record<string, Partial<typeof emptySession>> = {}) {
  const fetchMock = mockFetch((url) => {
    const path = new URL(url, 'http://x').pathname
    if (path === '/api/agents/lead/context') return jsonResponse(body)
    const session = /^\/api\/agents\/lead\/sessions\/([^/]+)\/context$/.exec(path)
    if (session)
      return jsonResponse({ ...emptySession, ...sessions[decodeURIComponent(session[1]!)] })
    return jsonResponse({}, 404)
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

const bar = () => screen.getByLabelText('Where this message goes')

test('names who the message goes to, the owner mark and the topic', async () => {
  stubContext({ model: null, tokens: null, costUsd: null, contextLength: null })
  renderInRoom(
    <ContextBar
      roomId="room-1"
      to={[]}
      subjectId="lead"
      agents={agents}
      ownerId="lead"
      topic={makeJob({ title: 'Activity feed' })}
    />,
  )
  expect(bar().textContent).toContain('To lead (owner) · in Activity feed')
  expect(bar().textContent).toContain('/compress when it fills up')
})

test('explicit recipients replace the default, and the general conversation has no topic', () => {
  stubContext({ model: null, tokens: null, costUsd: null, contextLength: null })
  renderInRoom(
    <ContextBar
      roomId="room-1"
      to={['builder', 'reviewer']}
      subjectId="builder"
      agents={agents}
      ownerId="lead"
      topic={makeJob({ isDefault: true, title: 'General' })}
    />,
  )
  expect(bar().textContent).toContain('To builder, reviewer')
  expect(bar().textContent).not.toContain('(owner)')
  expect(bar().textContent).not.toContain(' in ')
})

test('the meter reads the session the message lands in: the room session for the general conversation', async () => {
  const fetchMock = stubContext(
    {
      model: 'agent-model',
      tokens: { input: 90_000, output: 0 },
      costUsd: 0,
      contextLength: 100_000,
    },
    { 'score-room-1-lead': { window: 100_000, used: 40_000, model: 'demo-model' } },
  )
  renderInRoom(
    <ContextBar
      roomId="room-1"
      to={[]}
      subjectId="lead"
      agents={agents}
      ownerId="lead"
      topic={undefined}
    />,
  )
  const meter = await screen.findByRole('meter', { name: 'Context used' })
  expect(meter.getAttribute('aria-valuenow')).toBe('40')
  expect(meter.getAttribute('aria-valuetext')).toContain('40%')
  expect(bar().textContent).toContain('Model demo-model')
  // Never the agent's last session (which may be another chat's): 90% must not show.
  expect(bar().textContent).not.toContain('90%')
  expect(
    fetchMock.mock.calls.some(([url]) =>
      String(url).includes('sessions/score-room-1-lead/context'),
    ),
  ).toBe(true)
})

test("a topic's meter reads that topic's own session", async () => {
  stubContext(
    { model: 'agent-model', tokens: null, costUsd: null, contextLength: null },
    {
      'score-room-1-lead': { window: 100_000, used: 10_000 },
      'score-room-1-job-7-lead': { window: 200_000, used: 150_000 },
    },
  )
  renderInRoom(
    <ContextBar
      roomId="room-1"
      to={[]}
      subjectId="lead"
      agents={agents}
      ownerId="lead"
      topic={makeJob({ id: 'job-7', title: 'Release notes' })}
    />,
  )
  const meter = await screen.findByRole('meter', { name: 'Context used' })
  expect(meter.getAttribute('aria-valuenow')).toBe('75')
  // A session that has not run yet has no model: the agent's model is shown.
  expect(bar().textContent).toContain('Model agent-model')
})

test('leaves out what the read does not give instead of inventing it', async () => {
  const fetchMock = stubContext({ model: null, tokens: null, costUsd: null, contextLength: null })
  renderInRoom(
    <ContextBar
      roomId="room-1"
      to={[]}
      subjectId="lead"
      agents={agents}
      ownerId="lead"
      topic={undefined}
    />,
  )
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled())
  expect(screen.queryByRole('meter')).toBeNull()
  expect(bar().textContent).not.toContain('Model')
})

test('with nobody to address it says so', () => {
  stubContext({})
  renderInRoom(
    <ContextBar
      roomId="room-1"
      to={[]}
      subjectId={null}
      agents={agents}
      ownerId={null}
      topic={undefined}
    />,
  )
  expect(bar().textContent).toContain('To nobody yet')
})
