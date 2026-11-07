import { screen, within } from '@testing-library/react'
import { expect, test } from 'vitest'
import { open } from './BoldSettings-helpers.tsx'

test('Recipes is a Settings section: its list and editor sit inside the frame', async () => {
  open('/b/settings/recipes')
  const nav = screen.getByRole('navigation', { name: 'Settings' })
  expect(
    within(nav)
      .getByRole('button', { name: /^Recipes/ })
      .getAttribute('aria-current'),
  ).toBe('page')
  expect(await screen.findByRole('heading', { name: 'Recipes', level: 2 })).toBeDefined()
  // The top bar no longer carries a Recipes button.
  expect(
    within(screen.getByRole('navigation', { name: 'Main' })).queryByRole('button', {
      name: 'Recipes',
    }),
  ).toBeNull()
})

test('a recipe’s own address opens the Recipes section, not Usage (3.27.0 review)', async () => {
  open('/b/settings/recipes/wf-1')
  const nav = screen.getByRole('navigation', { name: 'Settings' })
  expect(
    within(nav)
      .getByRole('button', { name: /^Recipes/ })
      .getAttribute('aria-current'),
  ).toBe('page')
  expect(
    within(nav)
      .getByRole('button', { name: /^Usage/ })
      .getAttribute('aria-current'),
  ).toBeNull()
})
