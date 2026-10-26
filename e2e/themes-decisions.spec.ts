import { expect, test, type Page } from '@playwright/test'
import { mockThemes, type Look } from './themes-fixtures.ts'
import { holdLockPerTest } from './locks.ts'
import { pair } from './pair.ts'

// Phase 9 re-gate (decision 102, H3, finding 6): a decision is vetted as a whole. These specs commit the real forms
// and buttons in the same task as a rule that slipped past the sanitiser lands (nothing in between can notice it), so
// only the click-time or submit-time vetting can stop the action. Nothing may be sent, and Score says why.
// The decision here is Add an agent › A coding tool in the new shell; the specs share the team, so they take its lock.

holdLockPerTest('roster')

async function wear(page: Page, css = '.main { box-shadow: 0 1px 2px rgb(0 0 0 / 12%); }') {
  const look: Look = { active: 'gate', mode: 'light' }
  await mockThemes(
    page,
    [{ id: 'gate', name: 'Gate', source: 'imported', manifest: {}, css }],
    look,
  )
  await pair(page)
}

/** Add an agent › A coding tool, with a name; the first tool on the list is chosen, which needs no acknowledgement. */
async function openAddCodingAgent(page: Page, id: string) {
  await page.goto('/b/team?add=agent')
  const dialog = page.getByRole('dialog', { name: 'Add an agent' })
  await dialog.getByRole('radio', { name: /A coding tool/ }).check()
  await dialog.getByLabel('Name', { exact: true }).fill(id)
  await dialog.getByLabel('What does it do?').fill('Reviews build scripts.')
  const add = dialog.getByRole('button', { name: 'Add coding agent' })
  await expect(add).toBeEnabled()
  await expect(page.locator('html')).toHaveAttribute('data-look', 'custom')
  return dialog
}

/** The specs share one server: remove the agent a test made. */
async function removeCoding(page: Page, id: string) {
  await page.evaluate(async (agentId) => {
    await fetch(`/api/coding-agents/${encodeURIComponent(agentId)}`, {
      method: 'DELETE',
      headers: { 'X-Score-Client': 'web' },
    })
  }, id)
}

test.describe('the add-coding-agent form is one decision (re-gate #6)', () => {
  for (const [name, rule, commit] of [
    [
      'a hidden “Add coding agent” button can’t be reached by submitting the form',
      '.bold-add-footer { display: none !important; }',
      'submit',
    ],
    ['a faded button can’t be clicked', '.bold-add-footer { opacity: 0; }', 'click'],
    [
      'hidden context and warnings refuse the click on the visible button',
      'p.team-muted-strong, .coding-reach, .coding-add-context { display: none !important; }',
      'click',
    ],
  ] as const) {
    test(`#6: ${name}`, async ({ page }) => {
      test.setTimeout(90_000)
      await wear(page)
      const id = `gate-${Date.now().toString(36)}`
      const posts: string[] = []
      page.on('request', (request) => {
        if (request.method() === 'POST' && /\/api\/coding-agents$/.test(request.url()))
          posts.push(request.url())
      })
      try {
        const dialog = await openAddCodingAgent(page, id)
        await page.evaluate(
          ([text, how]) => {
            document.adoptedStyleSheets.at(-1)!.insertRule(text!)
            // The same task: no timer, observer or animation frame has run since the rule landed.
            const form = document.querySelector<HTMLFormElement>(
              'form.bold-add-form[data-decision]',
            )!
            if (how === 'submit') form.requestSubmit()
            else
              form.querySelector<HTMLButtonElement>('.bold-add-footer .coding-add-commit')!.click()
          },
          [rule, commit],
        )
        await expect(page.locator('.look-banner')).toContainText('Nothing was sent', {
          timeout: 15_000,
        })
        await expect(page.locator('html')).not.toHaveAttribute('data-look', 'custom')
        expect(posts).toEqual([])
        // Score’s own look is back and the same form commits for real.
        await dialog.getByRole('button', { name: 'Add coding agent' }).click()
        await expect(dialog.getByRole('heading', { name: `${id} joined the team` })).toBeVisible({
          timeout: 15_000,
        })
        expect(posts).toHaveLength(1)
      } finally {
        if (posts.length > 0) await removeCoding(page, id)
      }
    })
  }
})

// Third gate, finding 1: the theme CSS below is accepted by the sanitiser (it is ordinary opacity and colour on the
// form's own labels), so nothing slips in afterwards and the periodic check has no protected surface to notice. Only
// the decision's vetting at the commit can stop the submit.
test.describe('every field of the add-coding-agent form is part of the decision (third gate #1)', () => {
  for (const [name, css] of [
    ['faded labels and their fields', '.bold-add-fields > label { opacity: 0; }'],
    [
      'transparent label text',
      '.bold-add-fields > label { color: transparent; text-shadow: none; }',
    ],
  ] as const) {
    test(`#1: ${name} refuse the real submit and send nothing`, async ({ page }) => {
      test.setTimeout(90_000)
      await wear(page, `.main { box-shadow: 0 1px 2px rgb(0 0 0 / 12%); } ${css}`)
      const id = `gate-${Date.now().toString(36)}`
      const posts: string[] = []
      page.on('request', (request) => {
        if (request.method() === 'POST' && /\/api\/coding-agents$/.test(request.url()))
          posts.push(request.url())
      })
      try {
        const dialog = await openAddCodingAgent(page, id)
        // The accepted rule really is on the page (sanitised, not slipped in).
        const property = name.startsWith('faded') ? 'opacity' : 'color'
        const applied = await dialog
          .locator('.bold-add-fields > label')
          .first()
          .evaluate((label, prop) => getComputedStyle(label).getPropertyValue(prop), property)
        expect(applied).toMatch(property === 'opacity' ? /^0$/ : /^rgba\(0, 0, 0, 0\)$/)
        await dialog.getByRole('button', { name: 'Add coding agent' }).click()
        await expect(page.locator('.look-banner')).toContainText('Nothing was sent', {
          timeout: 15_000,
        })
        await expect(page.locator('html')).not.toHaveAttribute('data-look', 'custom')
        expect(posts).toEqual([])
        // Score’s own look is back and the same form commits for real.
        await dialog.getByRole('button', { name: 'Add coding agent' }).click()
        await expect(dialog.getByRole('heading', { name: `${id} joined the team` })).toBeVisible({
          timeout: 15_000,
        })
        expect(posts).toHaveLength(1)
      } finally {
        if (posts.length > 0) await removeCoding(page, id)
      }
    })
  }
})

test('#1: a theme that only restyles the form’s labels (type, colour, corners) still lets it commit', async ({
  page,
}) => {
  test.setTimeout(90_000)
  await wear(
    page,
    '.bold-add-fields > label { font-family: "Georgia", serif; font-weight: 700; color: #2a2a3a; } .bold-add-fields input { border-radius: 2px; }',
  )
  const id = `gate-${Date.now().toString(36)}`
  const posts: string[] = []
  page.on('request', (request) => {
    if (request.method() === 'POST' && /\/api\/coding-agents$/.test(request.url()))
      posts.push(request.url())
  })
  try {
    const dialog = await openAddCodingAgent(page, id)
    await dialog.getByRole('button', { name: 'Add coding agent' }).click()
    await expect(dialog.getByRole('heading', { name: `${id} joined the team` })).toBeVisible({
      timeout: 15_000,
    })
    expect(posts).toHaveLength(1)
    await expect(page.locator('.look-banner')).toHaveCount(0)
  } finally {
    if (posts.length > 0) await removeCoding(page, id)
  }
})

test('#9: a host reset also clears the device’s light/dark choice', async ({ page }) => {
  const look: Look = { active: 'score', mode: 'system', resetGeneration: 0 }
  await mockThemes(page, [], look)
  await pair(page)
  await page.goto('/b')
  await page.evaluate(() => window.localStorage.setItem('score.theme', 'dark'))
  await page.reload()
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark')
  // `scripts/score look reset`: the shared look goes back to system and the generation moves on.
  look.resetGeneration = 1
  await page.reload()
  await expect(page.locator('html')).not.toHaveAttribute('data-theme', /.+/)
  expect(await page.evaluate(() => window.localStorage.getItem('score.theme'))).toBeNull()
})
