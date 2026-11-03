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

function stubContext(body: unknown) {
  const fetchMock = mockFetch((url) => {
    if (new URL(url, 'http://x').pathname === '/api/agents/lead/context') return jsonResponse(body)
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

test('shows the context meter and the model of the agent addressed, from the context read', async () => {
  stubContext({
    model: 'demo-model',
    tokens: { input: 30_000, output: 10_000 },
    costUsd: 0.2,
    contextLength: 100_000,
  })
  renderInRoom(
    <ContextBar to={[]} subjectId="lead" agents={agents} ownerId="lead" topic={undefined} />,
  )
  const meter = await screen.findByRole('meter', { name: 'Context used' })
  expect(meter.getAttribute('aria-valuenow')).toBe('40')
  expect(meter.getAttribute('aria-valuetext')).toContain('40%')
  expect(bar().textContent).toContain('Model demo-model')
})

test('leaves out what the read does not give instead of inventing it', async () => {
  const fetchMock = stubContext({ model: null, tokens: null, costUsd: null, contextLength: null })
  renderInRoom(
    <ContextBar to={[]} subjectId="lead" agents={agents} ownerId="lead" topic={undefined} />,
  )
  await vi.waitFor(() => expect(fetchMock).toHaveBeenCalled())
  expect(screen.queryByRole('meter')).toBeNull()
  expect(bar().textContent).not.toContain('Model')
})

test('with nobody to address it says so', () => {
  stubContext({})
  renderInRoom(
    <ContextBar to={[]} subjectId={null} agents={agents} ownerId={null} topic={undefined} />,
  )
  expect(bar().textContent).toContain('To nobody yet')
})
