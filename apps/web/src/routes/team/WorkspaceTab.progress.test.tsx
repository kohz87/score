import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createQueryClient } from '../../data/query-client.ts'
import { ControlledXhr, installControlledXhr } from '../../test/controlled-xhr.ts'
import { WorkspaceTab } from './WorkspaceTab.tsx'

const MB = 1024 * 1024
const json = (status: number, body: unknown) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
beforeEach(() => {
  installControlledXhr()
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string) => {
      const url = new URL(input, 'http://score.test')
      const tail = url.pathname.replace('/api/agents/builder/workspace', '')
      if (tail === '') return json(200, { root: '/work', available: true, reason: null })
      if (tail === '/tree') return json(200, { entries: [] })
      if (tail === '/git') return json(200, null)
      return json(404, { error: { code: 'not_found', message: 'no' } })
    }),
  )
  render(
    <QueryClientProvider client={createQueryClient()}>
      <WorkspaceTab agentId="builder" agentName="Builder" initialPath={null} />
    </QueryClientProvider>,
  )
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
const status = () => screen.getByRole('status')
const pick = async (...names: string[]) => {
  const input = (await screen.findByLabelText('Upload files')) as HTMLInputElement
  const files = names.map((name) => new File([new Uint8Array([1])], name))
  fireEvent.change(input, { target: { files } })
}

test('a workspace upload shows its file, percent and megabytes, then "Saving…", then "Uploaded"', async () => {
  await pick('photo.jpg')
  const xhr = await vi.waitFor(() => {
    const first = ControlledXhr.all[0]
    if (!first) throw new Error('not sent yet')
    return first
  })
  expect(xhr.method).toBe('POST')
  expect(xhr.url).toContain('/upload')
  expect(xhr.headers['content-type']).toBe('application/octet-stream')
  xhr.progress(3 * MB, 12 * MB)
  expect(status().textContent).toContain('photo.jpg')
  expect(status().textContent).toContain('Uploading · 25% · 3.0 MB of 12.0 MB')
  xhr.progress(12 * MB, 12 * MB)
  expect(status().textContent).toContain('Saving…')
  xhr.answer(201, { path: 'photo.jpg', size: 3 })
  expect(await screen.findByText('Uploaded photo.jpg.')).toBeTruthy()
})

test('several files show the one being sent, and a refusal keeps its message', async () => {
  await pick('a.txt', 'b.txt')
  const first = await vi.waitFor(() => {
    if (!ControlledXhr.all[0]) throw new Error('not sent yet')
    return ControlledXhr.all[0]
  })
  first.progress(1, 4)
  expect(status().textContent).toContain('a.txt')
  first.answer(409, { error: { code: 'exists', message: 'That name is taken' } })
  expect((await screen.findByRole('alert')).textContent).toBeTruthy()
  expect(ControlledXhr.all).toHaveLength(1)
})
