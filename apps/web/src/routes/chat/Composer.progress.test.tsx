import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { AgentSummary } from '@score/contract'
import { createQueryClient } from '../../data/query-client.ts'
import { ControlledXhr, installControlledXhr } from '../../test/controlled-xhr.ts'
import { Composer } from './Composer.tsx'
import { messagesQuery } from './queries.ts'

const agent: AgentSummary = {
  id: 'lead',
  name: 'Lead',
  role: 'Example',
  style: { color: '#6B4EFF', shape: 'circle-dot' },
  status: 'idle',
  activity: null,
  model: null,
  served: true,
}
const MB = 1024 * 1024
beforeEach(() => {
  installControlledXhr()
  const client = createQueryClient()
  client.setQueryData(messagesQuery('general').key, {
    asOfSeq: 1,
    data: { items: [], nextCursor: null, typing: {} },
  })
  vi.stubGlobal(
    'fetch',
    vi.fn(async () => new Response(JSON.stringify({ items: [] }))),
  )
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <Composer roomId="general" roomName="general" agents={[agent]} leadAgentId="lead" />
      </MemoryRouter>
    </QueryClientProvider>,
  )
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
const file = (name: string, type: string) => new File([new Uint8Array(4)], name, { type })
const tray = () => screen.getByRole('list', { name: 'Attachments' })

test('each attachment shows its own progress, then "Checking…", then becomes the attachment', async () => {
  fireEvent.change(screen.getByTestId('attach-input'), {
    target: { files: [file('report.pdf', 'application/pdf')] },
  })
  const xhr = ControlledXhr.all[0]!
  expect(xhr.method).toBe('POST')
  expect(xhr.url).toBe('/api/media')
  expect(xhr.sent).toBeInstanceOf(FormData)
  xhr.progress(2 * MB, 5 * MB)
  expect(within(tray()).getByRole('status').textContent).toContain('report.pdf · 40%')
  xhr.uploaded(5 * MB)
  expect(within(tray()).getByRole('status').textContent).toContain('report.pdf · Checking…')
  xhr.answer(201, { mediaId: 'm1', name: 'report.pdf', size: 4, contentType: 'application/pdf' })
  expect(await within(tray()).findByText('report.pdf')).toBeTruthy()
  expect(within(tray()).queryByRole('status')).toBeNull()
})

test('files sent together each have a chip of their own', async () => {
  fireEvent.change(screen.getByTestId('attach-input'), {
    target: { files: [file('a.pdf', 'application/pdf'), file('b.csv', 'text/csv')] },
  })
  // They go one after the other: the first is out, the second waits for it.
  const first = ControlledXhr.all[0]!
  first.progress(1 * MB, 4 * MB)
  expect(within(tray()).getByRole('status').textContent).toContain('a.pdf · 25%')
  first.answer(201, { mediaId: 'm1', name: 'a.pdf', size: 4, contentType: 'application/pdf' })
  await within(tray()).findByText('a.pdf')
  await vi.waitFor(() => expect(ControlledXhr.all).toHaveLength(2))
  ControlledXhr.all[1]!.progress(3 * MB, 4 * MB)
  expect(within(tray()).getByRole('status').textContent).toContain('b.csv · 75%')
})

test('a refused attachment keeps its message', async () => {
  fireEvent.change(screen.getByTestId('attach-input'), {
    target: { files: [file('big.pdf', 'application/pdf')] },
  })
  const xhr = ControlledXhr.all[0]!
  xhr.progress(4, 4)
  xhr.answer(413, { error: { code: 'too_large', message: 'big' } })
  expect((await screen.findByRole('alert')).textContent).toContain('big.pdf is too large')
  expect(screen.queryByRole('status')).toBeNull()
})
