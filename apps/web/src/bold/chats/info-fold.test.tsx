import { fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import {
  agents,
  disposeRoomTest,
  jsonResponse,
  makeExchange,
  makeJob,
  mockFetch,
  renderInRoom,
  room,
} from '../room/room-test-utils.tsx'
import { ChatInfo } from './ChatInfo.tsx'
import { InfoSection } from './InfoSection.tsx'
import { resetInfoFolds } from './info-test-utils.ts'
import { TopicInfo } from './TopicInfo.tsx'

beforeEach(() => {
  resetInfoFolds()
  vi.stubGlobal(
    'fetch',
    mockFetch((url) =>
      url === '/api/jobs/job-1/exchanges'
        ? jsonResponse({ asOfSeq: 1, items: [makeExchange()] })
        : jsonResponse({ asOfSeq: 0, items: [] }),
    ),
  )
})

afterEach(() => {
  resetInfoFolds()
  disposeRoomTest()
  vi.unstubAllGlobals()
})

const jobs = [
  makeJob({ id: 'job-default', title: 'Team room', isDefault: true }),
  makeJob({ id: 'job-1', title: 'Activity feed' }),
  makeJob({ id: 'job-2', title: 'Release notes', state: 'closed' }),
]

function toggle(name: RegExp | string) {
  return screen.getByRole('button', { name })
}

test('defaults: This topic and Files and results open; Members, Workspace and Topics folded, with summaries', () => {
  renderInRoom(<ChatInfo room={room} agents={agents} jobs={jobs} everyone />, ['/b?job=job-1'])
  expect(toggle(/This topic/).getAttribute('aria-expanded')).toBe('true')
  expect(toggle(/This topic/).textContent).toContain('▾')
  expect(toggle(/Files and results/).getAttribute('aria-expanded')).toBe('true')
  const members = toggle(/Members/)
  expect(members.getAttribute('aria-expanded')).toBe('false')
  expect(members.textContent).toContain('▸')
  expect(members.textContent).toContain(`Members · ${room.members.length}`)
  expect(toggle(/Workspace/).textContent).toContain('· none')
  expect(toggle(/Topics/).textContent).toContain('· 1 open')
  // aria-controls points at the body, which is hidden while folded.
  const body = document.getElementById(members.getAttribute('aria-controls')!)!
  expect(body.hidden).toBe(true)
})

test('a toggle opens and folds its section, and the choice is remembered on this device', () => {
  const first = renderInRoom(<ChatInfo room={room} agents={agents} jobs={jobs} everyone />)
  const members = toggle(/Members/)
  fireEvent.click(members)
  expect(members.getAttribute('aria-expanded')).toBe('true')
  expect(document.getElementById(members.getAttribute('aria-controls')!)!.hidden).toBe(false)
  expect(window.localStorage.getItem('score.info-fold.members')).toBe('open')
  first.unmount()
  renderInRoom(<ChatInfo room={room} agents={agents} jobs={jobs} everyone />)
  expect(toggle(/Members/).getAttribute('aria-expanded')).toBe('true')
})

test('without storage the defaults apply and the toggle still works', () => {
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
    throw new Error('blocked')
  })
  vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
    throw new Error('blocked')
  })
  try {
    renderInRoom(<ChatInfo room={room} agents={agents} jobs={jobs} everyone />)
    expect(toggle(/Members/).getAttribute('aria-expanded')).toBe('false')
    fireEvent.click(toggle(/Members/))
    expect(toggle(/Members/).getAttribute('aria-expanded')).toBe('true')
  } finally {
    vi.restoreAllMocks()
  }
})

test('?work=results and the openTopics counter open their sections even when the person folded them', () => {
  window.localStorage.setItem('score.info-fold.files', 'folded')
  window.localStorage.setItem('score.info-fold.topics', 'folded')
  renderInRoom(<ChatInfo room={room} agents={agents} jobs={jobs} everyone openTopics={1} />, [
    '/b?work=results',
  ])
  expect(toggle(/Files and results/).getAttribute('aria-expanded')).toBe('true')
  expect(toggle(/Topics/).getAttribute('aria-expanded')).toBe('true')
})

test('a section that holds a decision opens when one arrives and shows a protected badge once folded again', () => {
  const view = render(
    <InfoSection kind="topic" headingId="h" title="This topic" summary="Activity feed">
      body
    </InfoSection>,
  )
  fireEvent.click(toggle(/This topic/))
  expect(toggle(/This topic/).getAttribute('aria-expanded')).toBe('false')
  expect(screen.queryByText('Needs you')).toBeNull()
  view.rerender(
    <InfoSection kind="topic" headingId="h" title="This topic" summary="Activity feed" needsYou>
      body
    </InfoSection>,
  )
  expect(toggle(/This topic/).getAttribute('aria-expanded')).toBe('true')
  fireEvent.click(toggle(/This topic/))
  const badge = screen.getByText('Needs you')
  expect(badge.getAttribute('data-protected')).toBe('inline-flex')
  expect(badge.className).toContain('bold-info-needs')
})

test('This topic opens by itself for a paused exchange that needs the person, and stays reachable when folded', async () => {
  window.localStorage.setItem('score.info-fold.topic', 'folded')
  renderInRoom(<TopicInfo roomId="room-1" job={makeJob()} agents={agents} />)
  // The exchange arrives after the first render: the section opens.
  await waitFor(() => expect(toggle(/This topic/).getAttribute('aria-expanded')).toBe('true'))
  const pill = screen.getByText('Needs you')
  expect(pill.getAttribute('data-protected')).toBe('inline')
  fireEvent.click(toggle(/This topic/))
  const badge = document.querySelector('.bold-info-needs')
  expect(badge?.getAttribute('data-protected')).toBe('inline-flex')
})
