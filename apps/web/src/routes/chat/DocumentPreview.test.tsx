import { QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { MemoryRouter } from 'react-router'
import { afterEach, beforeEach, expect, test, vi } from 'vitest'
import { createQueryClient } from '../../data/query-client.ts'
import { DocumentChip, WorkspaceChip } from './DocumentChips.tsx'
import { CsvTable } from './DocumentPreview.tsx'

type Document = Parameters<typeof DocumentChip>[0]['part']
const part = (over: Partial<Document>): Document => ({
  kind: 'document',
  mediaId: 'm1',
  name: 'notes.txt',
  contentType: 'text/plain',
  size: 20,
  ...over,
})
let texts: Record<string, string>

function mount(node: React.ReactNode) {
  return render(
    <QueryClientProvider client={createQueryClient()}>
      <MemoryRouter>{node}</MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  texts = {}
  HTMLDialogElement.prototype.showModal = function showModal(this: HTMLDialogElement) {
    this.setAttribute('open', '')
  }
  HTMLDialogElement.prototype.close = function close(this: HTMLDialogElement) {
    this.removeAttribute('open')
    this.dispatchEvent(new Event('close'))
  }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (url: string) =>
      url in texts ? new Response(texts[url]) : new Response('missing', { status: 404 }),
    ),
  )
})
afterEach(() => {
  cleanup()
  vi.unstubAllGlobals()
})

test('a PDF is a download link, with no dialog', () => {
  mount(<DocumentChip part={part({ name: 'r.pdf', contentType: 'application/pdf' })} />)
  const link = screen.getByRole('link', { name: 'Download r.pdf' })
  expect(link.getAttribute('href')).toBe('/api/media/m1?download=1&name=r.pdf')
  expect(link.getAttribute('target')).toBeNull()
})

test('CSV shows as a table, header first, and stops at 1000 rows', () => {
  const rows = Array.from({ length: 1200 }, (_, i) => `${i},v${i}`)
  const { container } = render(<CsvTable text={['id,value', ...rows].join('\n')} />)
  expect(screen.getAllByRole('columnheader').map((cell) => cell.textContent)).toEqual([
    'id',
    'value',
  ])
  // Counted by element: a role query over a thousand rows is slow enough to time out on a loaded machine.
  expect(container.querySelectorAll('tr')).toHaveLength(1000)
  expect(screen.getByText(/Showing the first 1000 rows/)).toBeTruthy()
})

test('a CSV document previews as a table', async () => {
  texts['/api/media/m1'] = 'name,qty\nbolt,4\n'
  mount(<DocumentChip part={part({ name: 'p.csv', contentType: 'text/csv' })} />)
  fireEvent.click(screen.getByRole('button', { name: 'Preview p.csv' }))
  expect(await screen.findByRole('cell', { name: 'bolt' })).toBeTruthy()
  expect(screen.getByRole('link', { name: 'Download' }).getAttribute('href')).toBe(
    '/api/media/m1?download=1&name=p.csv',
  )
})

test('HTML is shown as source and never rendered', async () => {
  texts['/api/media/m1'] =
    '<h1>Title</h1><script>window.pwned = 1</script><img src=x onerror="window.pwned=1">'
  mount(<DocumentChip part={part({ name: 'p.html', contentType: 'text/html' })} />)
  fireEvent.click(screen.getByRole('button', { name: 'Preview p.html' }))
  const source = await screen.findByText(/<h1>Title<\/h1>/)
  expect(source.tagName).toBe('PRE')
  expect(
    document.querySelector('.chat-doc-dialog h1, .chat-doc-dialog img, .chat-doc-dialog script'),
  ).toBeNull()
  expect((window as unknown as { pwned?: number }).pwned).toBeUndefined()
})

test('Markdown goes through the chat renderer, which drops raw HTML', async () => {
  texts['/api/media/m1'] = '# Heading\n\n<b>raw</b> and **bold**'
  mount(<DocumentChip part={part({ name: 'n.md', contentType: 'text/markdown' })} />)
  fireEvent.click(screen.getByRole('button', { name: 'Preview n.md' }))
  expect(await screen.findByRole('heading', { name: 'Heading' })).toBeTruthy()
  expect(document.querySelector('.chat-doc-dialog b')).toBeNull()
  expect(document.querySelector('.chat-doc-dialog strong')?.textContent).toBe('bold')
})

test('JSON is pretty printed, and invalid JSON is shown as it is', async () => {
  texts['/api/media/m1'] = '{"a":1,"b":[2]}'
  mount(<DocumentChip part={part({ name: 'd.json', contentType: 'application/json' })} />)
  fireEvent.click(screen.getByRole('button', { name: 'Preview d.json' }))
  await waitFor(() =>
    expect(document.querySelector('.chat-doc-text')?.textContent).toBe(
      JSON.stringify({ a: 1, b: [2] }, null, 2),
    ),
  )
})

test('Word and Excel files offer download and the saved copy in the workspace', () => {
  mount(
    <DocumentChip
      part={part({
        name: 'q3.xlsx',
        contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        saved: [{ agentId: 'lead', path: 'attachments/2026-10-09/q3.xlsx' }],
      })}
    />,
  )
  fireEvent.click(screen.getByRole('button', { name: 'Preview q3.xlsx' }))
  expect(screen.getByText(/can’t show Word and Excel/)).toBeTruthy()
  expect(screen.getByRole('link', { name: 'Download' }).getAttribute('href')).toContain(
    'download=1',
  )
  expect(screen.getByRole('link', { name: 'Open in workspace' }).getAttribute('href')).toBe(
    '/team/lead/workspace?path=attachments%2F2026-10-09%2Fq3.xlsx',
  )
})

test('a workspace reference links to the file in the Workspace tab', () => {
  mount(<WorkspaceChip part={{ kind: 'workspace', agentId: 'builder', path: 'src/main.ts' }} />)
  expect(
    screen.getByRole('link', { name: 'Open src/main.ts in the workspace' }).getAttribute('href'),
  ).toBe('/team/builder/workspace?path=src%2Fmain.ts')
})
