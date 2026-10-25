import type { Job, JobReportBack } from '@score/contract'
import { fireEvent, screen, waitFor } from '@testing-library/react'
import { afterEach, expect, test, vi } from 'vitest'
import { ReportBackLine, reportBackText } from './ReportBack.tsx'
import {
  disposeRoomTest,
  jsonResponse,
  makeJob,
  mockFetch,
  renderInRoom,
} from './room-test-utils.tsx'

afterEach(() => {
  disposeRoomTest()
  vi.unstubAllGlobals()
})

const source = {
  app: 'Tickets app',
  ref: 'TCK-142',
  title: 'Login times out after 5 minutes',
  link: 'https://tickets.example.com/t/142',
  triggerId: 'trigger-1',
  missing: [],
}

function reportJob(reportBack: JobReportBack): Job {
  return makeJob({ source, reportBack })
}

function stubJobs(job: Job) {
  const fetchMock = mockFetch((url, init) => {
    if (url === '/api/rooms/room-1/jobs') return jsonResponse({ asOfSeq: 1, items: [job] })
    if (url === '/api/jobs/job-1/report-back' && init.method === 'POST')
      return jsonResponse({ ok: true })
    return jsonResponse({ asOfSeq: 0, items: [] })
  })
  vi.stubGlobal('fetch', fetchMock)
  return fetchMock
}

test('report-back copy is exact for every state', () => {
  const at = '2026-10-24T09:20:00.000Z'
  expect(reportBackText({ state: 'waiting', tool: null, at: null }, source)).toBe(
    'Will send the result back to TCK-142 when done',
  )
  expect(reportBackText({ state: 'needs_ok', tool: 'add_comment', at: null }, source)).toBe(
    'Send the result back to TCK-142? add_comment',
  )
  expect(reportBackText({ state: 'sending', tool: 'add_comment', at: null }, source)).toBe(
    'Sending the result back…',
  )
  expect(reportBackText({ state: 'confirmed', tool: 'add_comment', at }, source)).toMatch(
    /^Sent back /,
  )
  expect(reportBackText({ state: 'not_confirmed', tool: 'add_comment', at }, source)).toBe(
    'Couldn’t confirm the result was sent back',
  )
  expect(reportBackText({ state: 'off', tool: null, at: null }, source)).toBeNull()
})

test.each([
  ['waiting', 'Will send the result back to TCK-142 when done'],
  ['needs_ok', 'Send the result back to TCK-142? add_comment'],
  ['sending', 'Sending the result back…'],
  ['not_confirmed', 'Couldn’t confirm the result was sent back'],
] as const)('the %s state is a protected line with its decision', async (state, copy) => {
  stubJobs(reportJob({ state, tool: 'add_comment', at: null }))
  renderInRoom(<ReportBackLine job={reportJob({ state, tool: 'add_comment', at: null })} />)

  const line = await screen.findByText(copy)
  expect(line.closest('[data-protected]')?.getAttribute('data-protected')).toBe('block')
})

test('a confirmed result says when it was sent, and off shows nothing', async () => {
  stubJobs(reportJob({ state: 'confirmed', tool: 'add_comment', at: '2026-10-24T09:20:00.000Z' }))
  const { unmount } = renderInRoom(
    <ReportBackLine
      job={reportJob({ state: 'confirmed', tool: 'add_comment', at: '2026-10-24T09:20:00.000Z' })}
    />,
  )
  expect(await screen.findByText(/^Sent back /)).toBeDefined()
  unmount()

  renderInRoom(<ReportBackLine job={reportJob({ state: 'off', tool: null, at: null })} />)
  await waitFor(() => expect(screen.queryByText(/Send the result back|Sent back/)).toBeNull())
})

test('Send posts once with an idempotency key', async () => {
  const job = reportJob({ state: 'needs_ok', tool: 'add_comment', at: null })
  const fetchMock = stubJobs(job)
  renderInRoom(<ReportBackLine job={job} />)

  fireEvent.click(await screen.findByRole('button', { name: 'Send' }))
  await waitFor(() =>
    expect(
      fetchMock.mock.calls.some(
        ([url, init]) => String(url) === '/api/jobs/job-1/report-back' && init?.method === 'POST',
      ),
    ).toBe(true),
  )
  const call = fetchMock.mock.calls.find(
    ([url, init]) => String(url) === '/api/jobs/job-1/report-back' && init?.method === 'POST',
  )!
  expect(new Headers(call[1]!.headers).get('Idempotency-Key')).toBeTruthy()
})

test('Try again posts the same report-back request', async () => {
  const job = reportJob({ state: 'not_confirmed', tool: 'add_comment', at: null })
  const fetchMock = stubJobs(job)
  renderInRoom(<ReportBackLine job={job} inThread />)

  fireEvent.click(await screen.findByRole('button', { name: 'Try again' }))
  await waitFor(() =>
    expect(
      fetchMock.mock.calls.filter(
        ([url, init]) => String(url) === '/api/jobs/job-1/report-back' && init?.method === 'POST',
      ),
    ).toHaveLength(1),
  )
})
