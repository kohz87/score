import { expect, test, type Page } from '@playwright/test'
import { mockThemes, type Look } from './themes-fixtures.ts'
import { pair } from './pair.ts'

// Phase 9 re-gate (decision 102, H3, finding 6): a decision is vetted as a whole. These specs commit the real forms
// and buttons in the same task as a rule that slipped past the sanitiser lands (nothing in between can notice it), so
// only the click-time or submit-time vetting can stop the action. Nothing may be sent, and Score says why.

async function wear(page: Page, css = '.now-card { box-shadow: 0 1px 2px rgb(0 0 0 / 12%); }') {
  const look: Look = { active: 'gate', mode: 'light' }
  await mockThemes(
    page,
    [{ id: 'gate', name: 'Gate', source: 'imported', manifest: {}, css }],
    look,
  )
  await pair(page)
}

async function openAddCodingAgent(page: Page, id: string) {
  await page.goto('/team')
  await page.getByRole('button', { name: 'Add agent' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('radio', { name: /Coding agent/ }).check()
  await expect(dialog.getByLabel('Kind of coding agent')).toHaveValue('claude-code')
  await dialog.getByLabel(/Agent name/).fill(id)
  await expect(dialog.getByRole('button', { name: 'Add coding agent' })).toBeEnabled()
  await expect(page.locator('html')).toHaveAttribute('data-look', 'custom')
  return dialog
}

test.describe('the add-coding-agent form is one decision (re-gate #6)', () => {
  for (const [name, rule, commit] of [
    [
      'a hidden “Add coding agent” button can’t be reached by submitting the form',
      '.team-file-actions { display: none; }',
      'submit',
    ],
    ['a faded button can’t be clicked', '.team-file-actions { opacity: 0; }', 'click'],
    [
      'hidden context and warnings refuse the click on the visible button',
      'p.team-muted-strong, .coding-reach { display: none; }',
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
              'dialog form.team-routine-form, [role=dialog] form.team-routine-form',
            )!
            if (how === 'submit') form.requestSubmit()
            else form.querySelector<HTMLButtonElement>('.team-file-actions .team-primary')!.click()
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
        // The specs share one server: leave the team as it was.
        if (posts.length > 0) {
          await page.goto(`/team/${encodeURIComponent(id)}`)
          page.once('dialog', (confirm) => void confirm.accept())
          await page.getByRole('button', { name: 'Remove agent' }).click()
          await expect(page).toHaveURL(/\/team$/)
        }
      }
    })
  }
})

test.describe('the task drawer’s request and its buttons are one decision (re-gate #6)', () => {
  test('#6: Approve is refused when the request text above it was hidden', async ({ page }) => {
    test.setTimeout(240_000)
    await wear(page)
    const decisions: string[] = []
    await page.route('**/api/approvals/*/decision', async (route) => {
      decisions.push(route.request().url())
      await route.abort()
    })
    let taskId: string | undefined
    await expect
      .poll(
        async () => {
          const response = await page.request.get('/api/approvals?status=pending')
          const { items } = (await response.json()) as {
            items: { id: string; actionable: boolean; refs: { kind: string; taskId?: string }[] }[]
          }
          taskId = items
            .find((item) => item.id.startsWith('approval-docs') && item.actionable)
            ?.refs.find((ref) => ref.kind === 'task')?.taskId
          return taskId
        },
        { timeout: 200_000, intervals: [1_000, 2_000, 5_000] },
      )
      .toBeTruthy()
    await page.goto(`/tasks/${taskId}`)
    const actions = page
      .getByRole('complementary', { name: 'Task details' })
      .getByRole('region', { name: 'Task actions' })
    await expect(actions.getByRole('button', { name: /^Approve/ })).toBeVisible({ timeout: 20_000 })
    await expect(page.locator('html')).toHaveAttribute('data-look', 'custom')
    await page.evaluate(() => {
      document.adoptedStyleSheets
        .at(-1)!
        .insertRule(
          '.task-drawer-approval p, .task-drawer-approval b { color: transparent !important; }',
        )
      document.querySelector<HTMLButtonElement>('.task-drawer-buttons button')!.click()
    })
    await expect(page.locator('.look-banner')).toContainText('Nothing was sent', {
      timeout: 15_000,
    })
    await expect(page.locator('html')).not.toHaveAttribute('data-look', 'custom')
    expect(decisions).toEqual([])
  })
})

// Finding 8: the chat-first view has the same way back as the admin view, in every layout.
test.describe('the chat-first view keeps a protected way back (re-gate #8)', () => {
  async function openUser(page: Page, manifest: Record<string, unknown> = {}) {
    const look: Look = { active: 'gate', mode: 'light' }
    await mockThemes(
      page,
      [{ id: 'gate', name: 'Gate', source: 'imported', manifest, css: '.chat-thread { gap: 0; }' }],
      look,
    )
    await pair(page)
    await page.goto('/u')
    await expect(page.locator('html')).toHaveAttribute('data-look', 'custom')
  }
  const slip = (page: Page, rule: string) =>
    page.evaluate((text) => {
      document.adoptedStyleSheets.at(-1)!.insertRule(text)
      document.body.append(document.createElement('i'))
    }, rule)

  test('#8: Ctrl+K opens the palette in /u and “Reset look” in it works, with the sidebar gone', async ({
    page,
  }) => {
    await openUser(page)
    await slip(page, '.user-sidebar { display: none; }')
    await page.keyboard.press('Control+k')
    const palette = page.getByRole('dialog', { name: 'Search or run a command' })
    await expect(palette).toBeVisible()
    await palette.getByRole('searchbox').fill('reset look')
    await palette.getByRole('button', { name: 'Reset look on this device' }).click()
    await expect(page.locator('html')).not.toHaveAttribute('data-look', 'custom')
  })

  test('#8: Settings, Admin view and Reset look stay on the page when the sidebar is hidden', async ({
    page,
  }) => {
    await page.setViewportSize({ width: 390, height: 800 })
    await openUser(page, { layout: { chat: { roomList: 'hidden-until-opened' } } })
    const way = page.getByRole('navigation', { name: 'Way back' })
    await expect(way.getByRole('button', { name: 'Admin view' })).toBeVisible()
    await expect(way.getByRole('button', { name: 'Reset look' })).toBeVisible()
    await way.getByRole('button', { name: 'Settings' }).click()
    await expect(page).toHaveURL(/\/settings$/)
  })

  test('#8: “Reset look” in the strip drops the theme', async ({ page }) => {
    await openUser(page)
    await page
      .getByRole('navigation', { name: 'Way back' })
      .getByRole('button', { name: 'Reset look' })
      .click()
    await expect(page.locator('html')).not.toHaveAttribute('data-look', 'custom')
  })

  for (const [name, rule] of [
    ['the avatar menu', '.avatar-menu { display: none; }'],
    ['the conversations button', '.user-menu-button, .user-top { display: none; }'],
  ] as const) {
    test(`#8: hiding ${name} switches the theme off`, async ({ page }) => {
      await page.setViewportSize({ width: 390, height: 800 })
      await openUser(page)
      // At phone width the sidebar is a drawer: open it so the avatar is on the page.
      if (name === 'the avatar menu')
        await page.getByRole('button', { name: 'Conversations' }).first().click()
      await slip(page, rule)
      await expect(page.locator('html')).not.toHaveAttribute('data-look', 'custom', {
        timeout: 15_000,
      })
    })
  }
})
