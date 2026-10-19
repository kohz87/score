import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { AgentSummary } from '@score/contract'
import { ControlledXhr, installControlledXhr } from '../../test/controlled-xhr.ts'
import { ImportAgent } from './ImportAgent.tsx'

const MB = 1024 * 1024
beforeEach(installControlledXhr)
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

function pick(name = 'scout.tar.gz', size = 200 * MB) {
  render(
    <QueryClientProvider client={new QueryClient()}>
      <MemoryRouter>
        <ImportAgent agents={[] as AgentSummary[]} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  fireEvent.click(screen.getByRole('button', { name: 'Import agent' }))
  const file = new File([new Uint8Array([1])], name, { type: 'application/gzip' })
  Object.defineProperty(file, 'size', { value: size })
  fireEvent.change(screen.getByLabelText('Archive'), { target: { files: [file] } })
}

const sent = () =>
  vi.waitFor(() => {
    if (!ControlledXhr.all[0]) throw new Error('not sent yet')
    return ControlledXhr.all[0]
  })

test('an archive shows percent and megabytes while it is sent, then "Checking the archive…"', async () => {
  pick()
  const xhr = await sent()
  expect(xhr.method).toBe('POST')
  expect(xhr.url).toBe('/api/agents/imports')
  expect(xhr.headers['content-type']).toBe('application/octet-stream')
  xhr.progress(84 * MB, 200 * MB)
  const status = await screen.findByRole('status')
  expect(status.textContent).toContain('Uploading · 42% · 84.0 MB of 200.0 MB')
  expect(status.querySelector('progress')?.getAttribute('value')).toBe(String(84 * MB))
  xhr.uploaded(200 * MB)
  expect(status.textContent).toContain('Checking the archive…')
  expect(status.querySelector('progress')?.hasAttribute('value')).toBe(false)
})

test('a refused archive still shows the server’s message and no progress', async () => {
  pick()
  const xhr = await sent()
  xhr.uploaded(200 * MB)
  xhr.answer(413, { error: { code: 'too_large', message: 'That archive is too large.' } })
  expect((await screen.findByRole('alert')).textContent).toContain('That archive is too large.')
  expect(screen.queryByRole('status')).toBeNull()
})
