import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import type { AgentSummary, ImportInspection } from '@score/contract'
import { ImportAgent } from './ImportAgent.tsx'

const existing = { id: 'lead', name: 'Lead', style: { color: '#19C39A', shape: 'circle' } }
const inspection: ImportInspection = {
  uploadId: '30000000-0000-4000-8000-000000000001',
  sizeBytes: 5000,
  archiveRoot: 'scout',
  suggestedId: 'scout',
  description: 'Reads and summarizes',
  model: 'example/model-1',
  configVersion: '31',
  skills: ['research/web'],
  plugins: ['notes'],
  memoryBytes: 1234,
  fileCount: 7,
  totalBytes: 9000,
  credentialFiles: [],
  hasBridge: false,
  warnings: ['Imported plugins run code on this machine. Import only archives you trust.'],
}
const operation = {
  id: '10000000-0000-4000-8000-000000000001',
  kind: 'import',
  targetName: 'scout',
  incarnationId: '20000000-0000-4000-8000-000000000001',
  requestHash: 'a'.repeat(64),
  state: 'running',
  steps: [{ name: 'import_profile', state: 'running' }],
  createdAt: '2026-10-09T00:00:00.000Z',
  updatedAt: '2026-10-09T00:00:00.000Z',
  nextStep: 'import_profile',
  error: null,
  exportPath: null,
}
let calls: { path: string; init: RequestInit }[]
let current: ImportInspection
beforeEach(() => {
  calls = []
  current = inspection
  vi.stubGlobal('fetch', async (path: string, init: RequestInit) => {
    calls.push({ path, init })
    const body = path === '/api/agents/imports' ? current : operation
    return new Response(JSON.stringify(body), { headers: { 'Content-Type': 'application/json' } })
  })
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})
async function openPreview() {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false }, mutations: { retry: false } },
  })
  render(
    <QueryClientProvider client={client}>
      <MemoryRouter>
        <ImportAgent agents={[existing as AgentSummary]} />
      </MemoryRouter>
    </QueryClientProvider>,
  )
  fireEvent.click(screen.getByRole('button', { name: 'Import agent' }))
  const file = new File([new Uint8Array([1, 2, 3])], 'scout.tar.gz', { type: 'application/gzip' })
  fireEvent.change(screen.getByLabelText('Archive'), { target: { files: [file] } })
  await screen.findByRole('heading', { name: 'In this archive' })
}
const importButton = () => document.querySelector('dialog button.team-primary') as HTMLButtonElement

test('shows what is inside, defaults the id from the archive and starts the import', async () => {
  await openPreview()
  expect(screen.getByText('example/model-1')).toBeTruthy()
  expect(screen.getByText('research/web')).toBeTruthy()
  expect(screen.getByText('notes')).toBeTruthy()
  expect(screen.getByRole('alert').textContent).toContain('run code')
  expect(calls[0]!.path).toBe('/api/agents/imports')
  expect((screen.getByLabelText('New agent id') as HTMLInputElement).value).toBe('scout')
  fireEvent.click(importButton())
  await screen.findByRole('heading', { name: 'Importing agent' })
  const start = calls.find((call) => call.path === '/api/agents/import')!
  expect(JSON.parse(String(start.init.body))).toMatchObject({
    uploadId: inspection.uploadId,
    id: 'scout',
    role: 'Reads and summarizes',
  })
})

test('an id that already exists is refused in the form', async () => {
  await openPreview()
  fireEvent.change(screen.getByLabelText('New agent id'), { target: { value: 'lead' } })
  expect(
    screen.getAllByRole('alert').some((el) => /already exists/.test(el.textContent ?? '')),
  ).toBe(true)
  expect(importButton().disabled).toBe(true)
})

test('credential files are listed by name and need a checkbox', async () => {
  current = { ...inspection, credentialFiles: ['.env'] }
  await openPreview()
  expect(screen.getByText('.env')).toBeTruthy()
  expect(importButton().disabled).toBe(true)
  fireEvent.click(screen.getByRole('checkbox', { name: /credential files/ }))
  expect(importButton().disabled).toBe(false)
})

test('cancelling the preview deletes the stored upload', async () => {
  await openPreview()
  fireEvent.click(screen.getByRole('button', { name: 'Cancel' }))
  await waitFor(() =>
    expect(calls.some((call) => call.path === `/api/agents/imports/${inspection.uploadId}`)).toBe(
      true,
    ),
  )
})
