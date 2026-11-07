import { cleanup, fireEvent, screen } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { createWorkspaceTabHarness, json, view } from './workspace-tab-test-helpers.tsx'

const workspace = createWorkspaceTabHarness()

test('an unavailable workspace shows the reason and lets the folder be set', async () => {
  workspace.info = {
    root: null,
    available: false,
    reason: 'No working folder is set for this agent',
  }
  workspace.mount()
  expect(await screen.findByText('No working folder is set for this agent')).toBeTruthy()
  fireEvent.change(screen.getByLabelText('Folder on this computer'), {
    target: { value: '/work/project' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Use this folder' }))
  expect(await screen.findByRole('tree', { name: 'Files' })).toBeTruthy()
  const put = workspace.calls.find((c) => c.method === 'PUT' && c.url.endsWith('/root'))!
  expect(put.body).toEqual({ path: '/work/project' })
})

test('a refused folder shows the server reason', async () => {
  workspace.info = { root: null, available: false, reason: 'unset' }
  vi.stubGlobal(
    'fetch',
    vi.fn(async (input: string, init?: RequestInit) =>
      init?.method === 'PUT'
        ? json(409, {
            error: {
              code: 'workspace_unavailable',
              message: 'The home folder cannot be a workspace',
            },
          })
        : workspace.handler(input, init),
    ),
  )
  workspace.mount()
  fireEvent.change(await screen.findByLabelText('Folder on this computer'), {
    target: { value: '/home/me' },
  })
  fireEvent.click(screen.getByRole('button', { name: 'Use this folder' }))
  expect((await screen.findByRole('alert')).textContent).toContain(
    'The home folder cannot be a workspace',
  )
})

test('the tree loads lazily: a folder is listed only when opened', async () => {
  workspace.mount()
  await screen.findByRole('treeitem', { name: /src/ })
  expect(workspace.treeCalls()).toEqual([
    '/api/agents/builder/workspace/tree?path=&root=%2Fwork%2Fproject',
  ])
  fireEvent.click(screen.getByRole('treeitem', { name: /src/ }))
  await screen.findByRole('treeitem', { name: /main\.ts/ })
  expect(workspace.treeCalls()).toContain(
    '/api/agents/builder/workspace/tree?path=src&root=%2Fwork%2Fproject',
  )
  expect(screen.getByRole('treeitem', { name: /src/ }).getAttribute('aria-expanded')).toBe('true')
})

test('the header shows the git branch and changed count only inside a repository', async () => {
  workspace.mount()
  await screen.findByRole('tree', { name: 'Files' })
  expect(screen.queryByLabelText(/Git branch/)).toBeNull()
  cleanup()
  workspace.gitStatus = { branch: 'trunk', changed: 3, ahead: 1, behind: 0 }
  workspace.mount()
  const badge = await screen.findByLabelText('Git branch trunk, 3 changed files')
  expect(badge.textContent).toContain('trunk')
  expect(badge.textContent).toContain('3 changed')
  expect(badge.textContent).toContain('↑1')
})

test(
  'a workspace:// deep link opens that file with its folders expanded; a bad path shows the error',
  { timeout: 20_000 },
  async () => {
    workspace.mount('src/main.ts')
    await screen.findByLabelText('Contents of src/main.ts', {}, { timeout: 10_000 })
    expect(view().state.doc.toString()).toBe('export {}')
    expect(screen.getByRole('treeitem', { name: /src/ }).getAttribute('aria-expanded')).toBe('true')
    cleanup()
    vi.stubGlobal(
      'fetch',
      vi.fn(async (input: string, init?: RequestInit) =>
        input.includes('/file?')
          ? json(403, { error: { code: 'blocked', message: 'That file is not available' } })
          : workspace.handler(input, init),
      ),
    )
    workspace.mount('.env')
    expect((await screen.findAllByRole('alert'))[0]!.textContent).toMatch(/not available|blocked/i)
  },
)

test('the separator resizes the file list with the keyboard and the width is remembered', async () => {
  window.localStorage.removeItem('score.workspace.treeWidth')
  workspace.mount()
  const bar = await screen.findByRole('separator', { name: 'Resize the file list' })
  expect(bar.getAttribute('aria-valuenow')).toBe('300')
  fireEvent.keyDown(bar, { key: 'ArrowRight' })
  expect(bar.getAttribute('aria-valuenow')).toBe('316')
  fireEvent.keyDown(bar, { key: 'Home' })
  expect(bar.getAttribute('aria-valuenow')).toBe('200')
  fireEvent.keyDown(bar, { key: 'ArrowLeft' })
  expect(bar.getAttribute('aria-valuenow')).toBe('200')
  fireEvent.keyDown(bar, { key: 'End' })
  expect(bar.getAttribute('aria-valuenow')).toBe('640')
  expect(window.localStorage.getItem('score.workspace.treeWidth')).toBe('640')
  cleanup()
  workspace.mount()
  expect(
    (await screen.findByRole('separator', { name: 'Resize the file list' })).getAttribute(
      'aria-valuenow',
    ),
  ).toBe('640')
  window.localStorage.removeItem('score.workspace.treeWidth')
})

test('every file request names the root the browser is showing', async () => {
  workspace.mount()
  fireEvent.click(await screen.findByRole('treeitem', { name: /README\.md/ }))
  await screen.findByLabelText('Contents of README.md', {}, { timeout: 10_000 })
  const fileCalls = workspace.calls.filter((c) => /\/(tree|file|git)\b/.test(c.url))
  expect(fileCalls.length).toBeGreaterThan(2)
  for (const call of fileCalls) expect(call.url, call.url).toContain('root=%2Fwork%2Fproject')
}, 20_000)
