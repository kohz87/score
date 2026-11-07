// Recipe draft editing, validation, saving and version choice.
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { expect, test, vi } from 'vitest'
import { releaseDetail } from '../../../../e2e/workflow-fixtures.ts'
import { setUpRecipeTests, type PostHandler } from './BoldRecipes-helpers.tsx'

let post: PostHandler
const { json, mount, requests, saveButton, showText } = setUpRecipeTests({
  getPost: () => post,
  resetPost: () => {
    post = () => undefined
  },
})

test('the release recipe loads as seven numbered steps, is checked live, and undo/redo walks the draft', async () => {
  mount()
  const steps = await showText()
  const dialog = screen.getByRole('region', { name: 'Recipe editor' })
  await waitFor(() => expect(within(steps).getAllByRole('listitem')).toHaveLength(7))
  await waitFor(() =>
    expect(requests.some((request) => request.url === '/api/workflows/validate')).toBe(true),
  )

  fireEvent.click(within(steps).getByRole('button', { name: /^2.*Review the draft/ }))
  const title = screen.getByRole('textbox', { name: 'Title' })
  fireEvent.change(title, { target: { value: 'Review the copy' } })
  expect(within(steps).getByRole('button', { name: /^2.*Review the copy/ })).toBeTruthy()

  fireEvent.keyDown(dialog, { key: 'z', ctrlKey: true })
  expect(within(steps).getByRole('button', { name: /^2.*Review the draft/ })).toBeTruthy()
  fireEvent.keyDown(dialog, { key: 'z', ctrlKey: true, shiftKey: true })
  expect(within(steps).getByRole('button', { name: /^2.*Review the copy/ })).toBeTruthy()

  fireEvent.change(title, { target: { value: 'Typed, not undone' } })
  fireEvent.keyDown(title, { key: 'z', ctrlKey: true })
  expect((title as HTMLInputElement).value).toBe('Typed, not undone')
})

test('a dirty draft asks before leaving for the library', async () => {
  const router = mount()
  await showText()
  fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), {
    target: { value: 'Changed' },
  })
  const confirm = vi.spyOn(window, 'confirm').mockReturnValue(false)

  fireEvent.click(screen.getByRole('link', { name: '‹ Recipes' }))
  await waitFor(() =>
    expect(confirm).toHaveBeenCalledWith('You have unsaved changes. Leave without saving?'),
  )
  expect(router.state.location.pathname).toBe('/b/settings/recipes/wf-release')

  confirm.mockReturnValue(true)
  fireEvent.click(screen.getByRole('link', { name: '‹ Recipes' }))
  await waitFor(() => expect(router.state.location.pathname).toBe('/b/settings/recipes'))
})

test('a failed validation check says so and keeps Save disabled', async () => {
  const fetchMock = vi.mocked(fetch)
  const original = fetchMock.getMockImplementation()!
  fetchMock.mockImplementation((input, init) => {
    if (String(input) === '/api/workflows/validate' && init?.method === 'POST')
      return Promise.resolve(json({ error: { code: 'internal', message: 'check failed' } }, 500))
    return original(input, init)
  })
  mount()

  expect(await screen.findByText("Couldn't check this recipe")).toBeTruthy()
  await showText()
  fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), { target: { value: 'Edited' } })
  await waitFor(() => expect(saveButton().disabled).toBe(true))
})

test('a branch target changed from its row is saved as the same graph on a new version', async () => {
  mount()
  await showText()
  const target = await screen.findByRole('combobox', {
    name: 'Passed review?: otherwise goes to',
  })
  fireEvent.change(target, { target: { value: 'repaired' } })
  await waitFor(() => expect(saveButton().disabled).toBe(false))
  fireEvent.click(saveButton())

  await waitFor(() =>
    expect(requests.some((request) => request.url === '/api/workflows/wf-release/versions')).toBe(
      true,
    ),
  )
  const saved = requests.find((request) => request.url === '/api/workflows/wf-release/versions')!
  const body = JSON.parse(String(saved.init?.body)) as {
    baseVersion: number
    definition: typeof releaseDetail.latest.definition
  }
  expect(body.baseVersion).toBe(1)
  expect(body.definition.nodes.map((node) => node.id)).toEqual(
    releaseDetail.latest.definition.nodes.map((node) => node.id),
  )
  expect(body.definition.edges.find((edge) => edge.id === 'e5')).toMatchObject({
    from: 'passed',
    port: 'default',
    to: 'repaired',
  })
  expect(await screen.findByText('Saved as version 2.')).toBeTruthy()
})

test('a conflict offers both classic choices and keeps the draft', async () => {
  mount()
  await showText()
  fireEvent.change(screen.getByRole('textbox', { name: 'Title' }), { target: { value: 'Edited' } })
  await waitFor(() => expect(saveButton().disabled).toBe(false))
  const fetchMock = vi.mocked(fetch)
  const original = fetchMock.getMockImplementation()!
  fetchMock.mockImplementation((input, init) => {
    const url = String(input)
    if (url === '/api/workflows/wf-release/versions' && init?.method === 'POST')
      return Promise.resolve(
        json(
          { error: { code: 'conflict', message: 'newer version', details: { latestVersion: 4 } } },
          409,
        ),
      )
    return original(input, init)
  })
  fireEvent.click(saveButton())
  const conflict = await screen.findByRole('alert', { name: 'Someone saved first' })
  expect(
    within(conflict).getByRole('button', { name: 'Reload version 4 (discard my edits)' }),
  ).toBeTruthy()
  expect(
    within(conflict).getByRole('button', { name: 'Keep my draft and build on version 4' }),
  ).toBeTruthy()
  fireEvent.click(
    within(conflict).getByRole('button', { name: 'Keep my draft and build on version 4' }),
  )
  expect(await screen.findByRole('button', { name: 'Save as version 5' })).toBeTruthy()
})

test('Run opens Start a job with this recipe, and a saved version can be viewed read-only', async () => {
  const router = mount()
  fireEvent.click(await screen.findByRole('button', { name: 'More' }))
  fireEvent.change(await screen.findByLabelText('View a saved version (read-only)'), {
    target: { value: '1' },
  })
  expect(await screen.findByText('Version 1 (read-only)')).toBeTruthy()
  await waitFor(() =>
    expect(
      (screen.getByRole('button', { name: 'Edit a copy of version 1' }) as HTMLButtonElement)
        .disabled,
    ).toBe(false),
  )
  fireEvent.click(screen.getByRole('button', { name: 'Back to my draft' }))
  fireEvent.click(await screen.findByRole('button', { name: 'More' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Run…' }))
  await waitFor(() => expect(router.state.location.search).toBe('?start=job&recipe=wf-release'))
})

// ---- The graph editor (ported from the classic workflow editor's tests)

test('saving on top of a version someone else saved is explained, keeps the draft and offers a reload', async () => {
  post = (url) =>
    url === '/api/workflows/wf-release/versions'
      ? json({ error: { code: 'conflict', message: 'stale', details: { latestVersion: 2 } } }, 409)
      : undefined
  mount('/b/settings/recipes/wf-release')
  const name = (await screen.findByRole('textbox', { name: 'Recipe name' })) as HTMLInputElement
  fireEvent.change(name, { target: { value: 'Release notes v2' } })
  const save = screen.getByRole('button', { name: /^Save as version/ }) as HTMLButtonElement
  await waitFor(() => expect(save.disabled).toBe(false))
  fireEvent.click(save)
  const alert = await screen.findByRole('alert', { name: 'Someone saved first' })
  expect(
    within(alert).getByText(/Version 2 was saved while you were editing version 1/),
  ).toBeTruthy()
  expect(name.value).toBe('Release notes v2')
  const sent = requests.find((r) => r.url === '/api/workflows/wf-release/versions')!
  expect(JSON.parse(String(sent.init?.body)).baseVersion).toBe(1)
  expect(within(alert).getByRole('button', { name: /Reload version 2/ })).toBeTruthy()
})
