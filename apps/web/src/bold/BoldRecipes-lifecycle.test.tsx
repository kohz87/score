// Recipe archive and deletion.
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import { expect, test } from 'vitest'
import { releaseDetail, workflowFixtures } from '../../../../e2e/workflow-fixtures.ts'
import { setUpRecipeTests, type PostHandler } from './BoldRecipes-helpers.tsx'

let post: PostHandler
const { json, mount } = setUpRecipeTests({
  getPost: () => post,
  resetPost: () => {
    post = () => undefined
  },
})

test('a recipe with runs can be archived, and an archived one is hidden until Archived is shown', async () => {
  const summary = { ...releaseDetail, used: true, archivedAt: null as string | null }
  const fixtures = workflowFixtures as Record<string, unknown>
  const original = fixtures['/api/workflows']
  fixtures['/api/workflows'] = {
    ...(original as object),
    items: [summary],
  }
  post = (url) => {
    if (url === '/api/workflows/wf-release/archive') {
      summary.archivedAt = '2026-10-27T00:00:00.000Z'
      return json(summary)
    }
    if (url === '/api/workflows/wf-release/unarchive') {
      summary.archivedAt = null
      return json(summary)
    }
    return undefined
  }
  try {
    mount('/b/settings/recipes/wf-release')
    fireEvent.click(await screen.findByRole('button', { name: 'More' }))
    // Delete recipe is for a recipe nothing has run; this one has runs.
    expect(screen.queryByRole('button', { name: 'Delete recipe' })).toBeNull()
    fireEvent.click(screen.getByRole('button', { name: 'Archive' }))
    expect(await screen.findByText(/Archived: this recipe is hidden/)).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: 'Unarchive' }))
    await waitFor(() => expect(screen.queryByText(/Archived: this recipe is hidden/)).toBeNull())
  } finally {
    fixtures['/api/workflows'] = original
  }
})

test('Delete with runs asks for the recipe name and says it can not be undone', async () => {
  const fixtures = workflowFixtures as Record<string, unknown>
  const original = fixtures['/api/workflows']
  fixtures['/api/workflows'] = {
    ...(original as object),
    items: [{ ...releaseDetail, used: true, archivedAt: null }],
  }
  let body: unknown
  post = (url, init) => {
    if (url !== '/api/workflows/wf-release/delete-with-runs') return undefined
    body = JSON.parse(String(init?.body))
    return json({ deletedRuns: 2 })
  }
  try {
    const router = mount('/b/settings/recipes/wf-release')
    fireEvent.click(await screen.findByRole('button', { name: 'More' }))
    fireEvent.click(screen.getByRole('button', { name: 'Delete with runs…' }))
    const dialog = await screen.findByRole('alertdialog', { name: 'Delete recipe with its runs' })
    expect(dialog.getAttribute('data-protected')).toBe('flex')
    expect(dialog.textContent).toContain('can’t be undone')
    const confirm = within(dialog).getByRole('button', {
      name: 'Delete recipe and runs',
    }) as HTMLButtonElement
    expect(confirm.disabled).toBe(true)
    fireEvent.change(within(dialog).getByLabelText(/Type the recipe/), {
      target: { value: releaseDetail.name },
    })
    expect(confirm.disabled).toBe(false)
    fireEvent.click(confirm)
    await waitFor(() => expect(body).toEqual({ confirm: releaseDetail.name }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/b/settings/recipes'))
    // The library says what happened.
    expect((await screen.findByText('Deleted the recipe.')).getAttribute('role')).toBe('status')
    // The history entry no longer carries it, so a reload or a later visit doesn't repeat it (3.29.0 review).
    await waitFor(() => expect(router.state.location.state).toBeNull())
    expect(screen.getByText('Deleted the recipe.')).toBeDefined()
  } finally {
    fixtures['/api/workflows'] = original
  }
})

test('the delete-with-runs dialog takes focus, Escape cancels, and focus returns to More', async () => {
  const fixtures = workflowFixtures as Record<string, unknown>
  const original = fixtures['/api/workflows']
  fixtures['/api/workflows'] = {
    ...(original as object),
    items: [{ ...releaseDetail, used: true, archivedAt: null }],
  }
  try {
    mount('/b/settings/recipes/wf-release')
    const more = await screen.findByRole('button', { name: 'More' })
    fireEvent.click(more)
    fireEvent.click(screen.getByRole('button', { name: 'Delete with runs…' }))
    const dialog = await screen.findByRole('alertdialog', { name: 'Delete recipe with its runs' })
    const field = within(dialog).getByLabelText(/Type the recipe/)
    await waitFor(() => expect(document.activeElement).toBe(field))
    fireEvent.keyDown(dialog, { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('alertdialog')).toBeNull())
    expect(document.activeElement).toBe(more)
  } finally {
    fixtures['/api/workflows'] = original
  }
})
