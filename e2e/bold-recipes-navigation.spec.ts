import { expect, test } from '@playwright/test'
import { pair } from './pair.ts'
import { inspector, openRecipes, showText } from './bold-recipes-helpers.ts'

test('leaving a dirty recipe asks first, and the old addresses land on the page', async ({
  page,
}) => {
  await pair(page)
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await openRecipes(page, 'new')
  await showText(page)
  await inspector(page).getByLabel('Title').fill('Changed, not saved')
  // 3.29.0: "‹ Recipes" leads back to the library; a dirty draft asks first. Each answer is awaited with its own click.
  const back = page.getByRole('link', { name: '‹ Recipes' })
  const askedToStay = page.waitForEvent('dialog').then((prompt) => prompt.dismiss())
  await back.click({ noWaitAfter: true })
  await askedToStay
  await expect(page).toHaveURL(/\/b\/settings\/recipes\/new$/)
  await expect(inspector(page).getByLabel('Title')).toHaveValue('Changed, not saved')
  // The library replaces the page as the click lands, so Playwright's own waits for a stable link would race it.
  const askedToLeave = page.waitForEvent('dialog').then((prompt) => prompt.accept())
  await back.click({ noWaitAfter: true, force: true })
  await askedToLeave
  await expect(page).toHaveURL(/\/b\/settings\/recipes$/)
  await expect(page.getByRole('list', { name: 'Recipes', exact: true })).toBeVisible()
  await page
    .getByRole('listitem', { name: /lead decides/ })
    .getByRole('button', { name: /Run in a chat/ })
    .waitFor()

  for (const [from, to] of [
    ['/b?recipes=1', /\/b\/settings\/recipes$/],
    ['/b/workflows?x=1', /\/b\/settings\/recipes\?x=1$/],
    ['/workflows', /\/b\/settings\/recipes$/],
    ['/workflows#step', /\/b\/settings\/recipes#step$/],
    ['/b?recipes=1&job=j1#step', /\/b\/settings\/recipes\?job=j1#step$/],
    ['/b/recipes?x=1', /\/b\/settings\/recipes\?x=1$/],
    ['/b/recipes/lead-decides?x=1', /\/b\/settings\/recipes\/lead-decides\?x=1$/],
  ] as const) {
    await page.goto(from)
    await expect(page).toHaveURL(to)
    if (/lead-decides/.test(String(to)))
      await expect(page.getByRole('region', { name: 'Recipe editor' })).toBeVisible()
    else await expect(page.getByRole('list', { name: 'Recipes', exact: true })).toBeVisible()
  }
})
