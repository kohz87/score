import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { expect, test } from 'vitest'
import { createWorkspaceTabHarness, setText, view } from './workspace-tab-test-helpers.tsx'

const workspace = createWorkspaceTabHarness()

test(
  'open, edit and save sends the loaded etag; the button disables when clean',
  { timeout: 20_000 },
  async () => {
    workspace.mount()
    fireEvent.click(await screen.findByRole('treeitem', { name: /README\.md/ }))
    await screen.findByLabelText('Contents of README.md', {}, { timeout: 10_000 })
    expect(view().state.doc.toString()).toBe('hello')
    const save = screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement
    expect(save.disabled).toBe(true)
    setText('hello world')
    expect(save.disabled).toBe(false)
    fireEvent.click(save)
    await screen.findByText('Saved.')
    const put = workspace.calls.find((c) => c.method === 'PUT' && c.url.includes('/file'))!
    expect(put.body).toEqual({ content: 'hello world', etag: 'etag-1' })
    expect(put.url).toContain('path=README.md')
  },
)

test(
  'a stale etag shows the conflict banner; reload takes the disk version, overwrite retries with its etag',
  { timeout: 20_000 },
  async () => {
    workspace.mount()
    fireEvent.click(await screen.findByRole('treeitem', { name: /README\.md/ }))
    await screen.findByLabelText('Contents of README.md', {}, { timeout: 10_000 })
    setText('mine')
    workspace.saveStatus = 412
    workspace.files.set('README.md', 'on disk')
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    const banner = await screen.findByText('Changed on disk.')
    expect(banner).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: 'Compare' }))
    expect(((await screen.findByLabelText('On disk')) as HTMLTextAreaElement).value).toBe('on disk')
    expect((screen.getByLabelText('My version') as HTMLTextAreaElement).value).toBe('mine')
    workspace.saveStatus = 200
    fireEvent.click(screen.getByRole('button', { name: 'Overwrite with my version' }))
    await screen.findByText('Saved.')
    const puts = workspace.calls.filter((c) => c.method === 'PUT' && c.url.includes('/file'))
    expect(puts.at(-1)!.body).toEqual({ content: 'mine', etag: 'disk2' })

    // Reload path.
    setText('again')
    workspace.saveStatus = 412
    workspace.files.set('README.md', 'on disk')
    workspace.etag = 'disk2'
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))
    await screen.findByText('Changed on disk.')
    fireEvent.click(screen.getByRole('button', { name: 'Reload from disk' }))
    await waitFor(() => expect(view().state.doc.toString()).toBe('on disk'))
  },
)

test(
  'a Markdown file has a rendered Preview without raw HTML; code files have none',
  { timeout: 20_000 },
  async () => {
    workspace.files.set('README.md', '# Title\n\nsome **bold** <script>alert(1)</script>')
    workspace.mount()
    fireEvent.click(await screen.findByRole('treeitem', { name: /README\.md/ }))
    await screen.findByLabelText('Contents of README.md', {}, { timeout: 10_000 })
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
    const preview = screen.getByLabelText('Preview of README.md')
    expect(within(preview).getByRole('heading', { name: 'Title' })).toBeTruthy()
    expect(preview.querySelector('strong')?.textContent).toBe('bold')
    expect(preview.querySelector('script')).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Edit' }))
    await screen.findByLabelText('Contents of README.md')
    fireEvent.click(screen.getByRole('treeitem', { name: /src/ }))
    fireEvent.click(await screen.findByRole('treeitem', { name: /main\.ts/ }))
    await screen.findByLabelText('Contents of src/main.ts')
    expect(screen.queryByRole('button', { name: 'Preview' })).toBeNull()
  },
)

test(
  'a CSV file has a table Preview (at most 1000 rows); HTML stays source',
  { timeout: 20_000 },
  async () => {
    workspace.files.set('data.csv', 'name,qty\nbolt,4\n')
    workspace.files.set('page.html', '<h1>x</h1>')
    workspace.dirs
      .get('')!
      .push({ name: 'data.csv', kind: 'file' }, { name: 'page.html', kind: 'file' })
    workspace.mount()
    fireEvent.click(await screen.findByRole('treeitem', { name: /data\.csv/ }))
    await screen.findByLabelText('Contents of data.csv', {}, { timeout: 10_000 })
    fireEvent.click(screen.getByRole('button', { name: 'Preview' }))
    const preview = screen.getByLabelText('Preview of data.csv')
    expect(within(preview).getByRole('cell', { name: 'bolt' })).toBeTruthy()
    fireEvent.click(screen.getByRole('treeitem', { name: /page\.html/ }))
    await screen.findByLabelText('Contents of page.html')
    expect(screen.queryByRole('button', { name: 'Preview' })).toBeNull()
    expect(document.querySelector('.ws h1')).toBeNull()
  },
)

test(
  'a failed background read keeps the editor and the unsaved text, and says so',
  { timeout: 20_000 },
  async () => {
    workspace.mount()
    fireEvent.click(await screen.findByRole('treeitem', { name: /README\.md/ }))
    await screen.findByLabelText('Contents of README.md', {}, { timeout: 10_000 })
    setText('unsaved work')
    workspace.failFileReads = true
    const reads = () =>
      workspace.calls.filter((c) => c.method === 'GET' && c.url.includes('/file')).length
    const before = reads()
    await act(async () => {
      await workspace.client.refetchQueries({ queryKey: ['team', 'workspace', 'builder', 'file'] })
    })
    await waitFor(() => expect(reads()).toBeGreaterThan(before))
    expect((await screen.findByRole('alert')).textContent).toMatch(/Couldn’t/)
    expect(view().state.doc.toString()).toBe('unsaved work')
    // Retrying after the connection is back refreshes without replacing the draft.
    workspace.failFileReads = false
    fireEvent.click(screen.getByRole('button', { name: 'Try again' }))
    await waitFor(() => expect(screen.queryByRole('alert')).toBeNull())
    expect(view().state.doc.toString()).toBe('unsaved work')
  },
)

test('unsaved edits survive switching to another file and back, and are not mistaken for saved', async () => {
  workspace.mount()
  fireEvent.click(await screen.findByRole('treeitem', { name: /README\.md/ }))
  await screen.findByLabelText('Contents of README.md', {}, { timeout: 10_000 })
  setText('half-written')
  fireEvent.click(screen.getByRole('treeitem', { name: /src/ }))
  fireEvent.click(await screen.findByRole('treeitem', { name: /main\.ts/ }))
  await screen.findByLabelText('Contents of src/main.ts', {}, { timeout: 10_000 })
  fireEvent.click(screen.getByRole('treeitem', { name: /README\.md/ }))
  await screen.findByLabelText('Contents of README.md', {}, { timeout: 10_000 })
  expect(view().state.doc.toString()).toBe('half-written')
  expect((screen.getByRole('button', { name: 'Save' }) as HTMLButtonElement).disabled).toBe(false)
  expect(workspace.calls.filter((c) => c.method === 'PUT' && c.url.includes('/file'))).toHaveLength(
    0,
  )
}, 30_000)
