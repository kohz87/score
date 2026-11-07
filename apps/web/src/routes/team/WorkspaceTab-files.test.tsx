import { cleanup, fireEvent, screen, waitFor, within } from '@testing-library/react'
import { expect, test } from 'vitest'
import { createWorkspaceTabHarness } from './workspace-tab-test-helpers.tsx'

const workspace = createWorkspaceTabHarness()

test('images preview by URL and binaries offer a download', async () => {
  workspace.mount()
  fireEvent.click(await screen.findByRole('treeitem', { name: /logo\.png/ }))
  const img = (await screen.findByRole('img')) as HTMLImageElement
  expect(img.getAttribute('src')).toBe(
    '/api/agents/builder/workspace/file?path=logo.png&root=%2Fwork%2Fproject',
  )
  cleanup()
  workspace.mount()
  fireEvent.click(await screen.findByRole('treeitem', { name: /data\.bin/ }))
  await screen.findByText(/This is not a text file/)
  expect(screen.getByRole('link', { name: 'Download' }).getAttribute('href')).toContain(
    'download=1',
  )
})

test('new file is created inside the selected folder', async () => {
  workspace.mount()
  fireEvent.click(await screen.findByRole('treeitem', { name: /src/ }))
  fireEvent.click(screen.getByRole('button', { name: 'New file' }))
  fireEvent.change(screen.getByLabelText(/New file in src/), { target: { value: 'util.ts' } })
  fireEvent.click(
    within(screen.getByRole('form', { name: 'new-file' })).getByRole('button', { name: 'Create' }),
  )
  await waitFor(() =>
    expect(
      workspace.calls.find((c) => c.method === 'POST' && c.url.includes('/entries'))?.body,
    ).toEqual({
      path: 'src/util.ts',
      kind: 'file',
    }),
  )
})

test('deleting a non-empty folder asks for its typed name before recursing', async () => {
  workspace.removeNotEmpty = true
  workspace.mount()
  fireEvent.click(await screen.findByRole('treeitem', { name: /src/ }))
  fireEvent.click(screen.getByRole('button', { name: 'Delete' }))
  fireEvent.click(screen.getByRole('button', { name: 'Confirm delete' }))
  const confirm = (await screen.findByRole('button', {
    name: 'Delete everything',
  })) as HTMLButtonElement
  expect(confirm.disabled).toBe(true)
  fireEvent.change(screen.getByLabelText('Type the folder name to confirm'), {
    target: { value: 'src' },
  })
  expect(confirm.disabled).toBe(false)
  fireEvent.click(confirm)
  await screen.findByText('Deleted.')
  const deletes = workspace.calls.filter((c) => c.method === 'DELETE').map((c) => c.url)
  expect(deletes[0]).toContain('path=src')
  expect(deletes[0]).not.toContain('recursive')
  expect(deletes[1]).toContain('recursive=1')
})

test('upload posts the raw file as application/octet-stream into the current folder', async () => {
  workspace.mount()
  await screen.findByRole('treeitem', { name: /README\.md/ })
  const input = screen.getByLabelText('Upload files') as HTMLInputElement
  const file = new File([new Uint8Array([1, 2, 3])], 'photo.jpg', { type: 'image/jpeg' })
  fireEvent.change(input, { target: { files: [file] } })
  await screen.findByText('Uploaded photo.jpg.')
  const post = workspace.calls.find((c) => c.url.includes('/upload'))!
  expect(post.url).toContain('path=photo.jpg')
  expect(post.headers.get('content-type')).toBe('application/octet-stream')
  expect(post.body).toBe(file)
})

test('selecting several files uploads all of them even though the picker is cleared at once', async () => {
  workspace.mount()
  await screen.findByRole('treeitem', { name: /README\.md/ })
  const input = screen.getByLabelText('Upload files') as HTMLInputElement
  const a = new File([new Uint8Array([1])], 'a.txt')
  const b = new File([new Uint8Array([2])], 'b.txt')
  // A live FileList: clearing the input empties it.
  const list: File[] = [a, b]
  Object.defineProperty(input, 'files', { get: () => list, configurable: true })
  Object.defineProperty(input, 'value', {
    get: () => '',
    set: () => {
      list.length = 0
    },
    configurable: true,
  })
  fireEvent.change(input)
  await screen.findByText('Uploaded b.txt.')
  const uploaded = workspace.calls.filter((c) => c.url.includes('/upload')).map((c) => c.url)
  expect(uploaded).toHaveLength(2)
})
