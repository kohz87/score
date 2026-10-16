import { expect, test, type Page } from '@playwright/test'
import { pair } from './pair.ts'
import { makeRoom, say } from './rooms.ts'

// PLAN 8.4: the chat-first user view at /u, against the fake adapter's scripted lead (no model is called).
// A goal with [fake:ask] makes the lead ask a question; one with [fake:hold] keeps its step running until stopped.

const SECURITY_PASSWORD = 'e2e share password' // the same one conversations.spec.ts sets: the server keeps the first
const web = { 'x-score-client': 'web' }

async function startFromChat(page: Page, goal: string) {
  await page.goto('/u')
  await page.getByRole('link', { name: 'New chat' }).click()
  await page.getByRole('button', { name: 'Add', exact: true }).click()
  await page
    .getByRole('list', { name: 'Add' })
    .getByRole('button', { name: 'Start an orchestration…' })
    .click()
  const dialog = page.getByRole('dialog', { name: 'New orchestration' })
  // The compact dialog: no approvals, deadline or limits to fill in.
  await expect(dialog.getByText('Approvals', { exact: true })).toHaveCount(0)
  await expect(dialog.getByLabel('Deadline (optional)')).toHaveCount(0)
  await dialog.getByRole('textbox', { name: 'Goal' }).fill(goal)
  await dialog.getByRole('checkbox', { name: /builder/ }).check()
  await dialog.getByRole('checkbox', { name: /reviewer/ }).check()
  await dialog.getByRole('checkbox', { name: /Score controls the work it starts/ }).check()
  const start = dialog.getByRole('button', { name: 'Start orchestration' })
  await expect(start).toBeEnabled({ timeout: 15_000 })
  await start.click()
  await expect(dialog).toBeHidden()
  await expect(page).toHaveURL(/\/u\/rooms\//)
}

// A decision carries the revision the page showed; a click that races a fresh update is answered with a conflict, the
// run is read again and the person decides again.
async function approve(page: Page, step: string) {
  const gate = page.getByRole('region', { name: `Approve ${step}` })
  await expect(gate).toBeVisible({ timeout: 60_000 })
  await expect(async () => {
    if (await gate.isVisible()) await gate.getByRole('button', { name: `Approve ${step}` }).click()
    await expect(gate).toBeHidden({ timeout: 4000 })
  }).toPass({ timeout: 45_000 })
}

test('New chat: pick an agent, write the first message, and its direct room opens', async ({
  page,
}) => {
  await pair(page)
  await page.goto('/u')
  await page.getByRole('link', { name: 'New chat' }).click()
  await expect(
    page.getByRole('heading', { name: 'What would you like to work on?', level: 1 }),
  ).toBeVisible()
  const suggestions = page.getByRole('list', { name: 'Suggestions' })
  await expect(suggestions.getByRole('button', { name: /^Ask / })).toBeVisible()
  await expect(suggestions.getByRole('button', { name: 'Start an orchestration…' })).toBeVisible()
  // The whole admin interface stays out of this view.
  for (const name of ['Now', 'Reports', 'Team', 'Tasks', 'Knowledge', 'Settings'])
    await expect(page.getByRole('link', { name, exact: true })).toHaveCount(0)
  await page.getByRole('radio', { name: 'builder' }).click()
  const text = `Hello from the user view ${Date.now()}`
  await page.getByRole('combobox', { name: /^Message/ }).fill(text)
  await page.getByRole('button', { name: 'Send', exact: true }).click()
  await expect(page).toHaveURL(/\/u\/rooms\//)
  await expect(page.getByRole('heading', { name: 'builder', level: 1 })).toBeVisible()
  await expect(
    page.getByRole('region', { name: 'Message history' }).getByText(text).first(),
  ).toBeVisible()
  // Nothing of the admin view's room page leaks in.
  await expect(page.getByRole('link', { name: 'See it on the Score' })).toHaveCount(0)
})

test('rooms and direct rooms are in the sidebar, and a room is a centred conversation', async ({
  page,
}) => {
  await pair(page)
  const made = await makeRoom(page, 'uv')
  const asked = `Where are we with pagination ${Date.now()}`
  await say(page, made.id, asked)
  await page.goto('/u')
  const sidebar = page.getByRole('navigation', { name: 'Conversations' })
  await sidebar.getByRole('link', { name: made.label }).click({ timeout: 15_000 })
  await expect(page).toHaveURL(`/u/rooms/${made.id}`)
  await expect(page.getByRole('heading', { name: made.label, level: 1 })).toBeVisible()
  await expect(
    page.getByRole('region', { name: 'Message history' }).getByText(asked).first(),
  ).toBeAttached({ timeout: 15_000 })
  await expect(sidebar.getByRole('link', { name: made.label })).toHaveAttribute(
    'aria-current',
    'page',
  )
  await sidebar.getByRole('link', { name: /^lead/ }).first().click()
  await expect(page.getByRole('heading', { name: 'lead', level: 1 })).toBeVisible()
  // /u remembers the room this browser was last in.
  await page.goto('/u')
  await expect(page).toHaveURL(/\/u\/rooms\//)
})

test('an orchestration from chat: status lines arrive, every Needs-you item is answered in the chat', async ({
  page,
}) => {
  test.setTimeout(180_000)
  await pair(page)
  await startFromChat(page, 'Ship the release notes [fake:ask] e2e-uv1')
  // The run lives in its room: a live dot in the sidebar, and the room is named after the run.
  await expect(
    page
      .getByRole('navigation', { name: 'Conversations' })
      .getByRole('img', { name: 'Running now' })
      .first(),
  ).toBeVisible({ timeout: 30_000 })
  await expect(page.getByRole('textbox', { name: 'Message' })).toBeDisabled()
  // The lead's question is answered right in the conversation.
  const question = page.getByRole('region', { name: 'Question from the lead' })
  await expect(question).toContainText('Which audience is this for?', { timeout: 60_000 })
  await expect(page.getByText('Waiting for you: the lead has a question.')).toBeVisible()
  await question.getByLabel(/Your answer/).fill('ANSWER q1: engineers')
  await question.getByRole('button', { name: 'Send answer' }).click()
  await expect(page.getByText('You answered the lead’s question.')).toBeVisible({ timeout: 30_000 })
  // Gates are answered the same way, and each step shows up as a Score line between the lead's messages.
  await approve(page, 's1')
  await expect(page.getByText(/Step s1 \(builder\) finished\./)).toBeVisible({ timeout: 60_000 })
  await expect(page.getByText('You approved s1.')).toBeVisible()
  await approve(page, 's2')
  await expect(page.getByText('The run finished.')).toBeVisible({ timeout: 60_000 })
  // Score's lines are not messages: no agent glyph, nothing to reply to.
  const line = page.locator('[data-status-line]').first()
  await expect(line.locator('.agent-glyph')).toHaveCount(0)
  await expect(line.getByRole('button')).toHaveCount(0)
  // None of the admin pages are linked from here.
  await expect(page.getByRole('link', { name: 'Open the live diagram' })).toHaveCount(0)
})

test('Pause, Resume and Stop from the chat; See full details opens Flow in the admin view', async ({
  page,
}) => {
  test.setTimeout(180_000)
  await pair(page)
  await startFromChat(page, 'Hold [fake:hold] e2e-uv2')
  await approve(page, 's1')
  const run = page.getByRole('region', { name: 'Orchestration' })
  await expect(run.getByRole('button', { name: 'Pause' })).toBeVisible({ timeout: 30_000 })
  // A click on a stale reading of the run is answered with a conflict: read again and press again.
  await expect(async () => {
    if (await run.getByRole('button', { name: 'Pause' }).isVisible())
      await run.getByRole('button', { name: 'Pause' }).click()
    await expect(run.getByText('Paused by you')).toBeVisible({ timeout: 4000 })
  }).toPass({ timeout: 45_000 })
  await expect(page.getByText('You paused the run.')).toBeVisible()
  await expect(async () => {
    if (await run.getByRole('button', { name: 'Resume' }).isVisible())
      await run.getByRole('button', { name: 'Resume' }).click()
    await expect(run.getByRole('button', { name: 'Pause' })).toBeVisible({ timeout: 4000 })
  }).toPass({ timeout: 45_000 })
  await expect(async () => {
    if (!(await run.getByRole('button', { name: 'Stop the run' }).isVisible()))
      await run.getByRole('button', { name: 'Stop', exact: true }).click()
    await run.getByRole('button', { name: 'Stop the run' }).click({ timeout: 3000 })
    await expect(page.getByText('Stopping the run.')).toBeVisible({ timeout: 4000 })
  }).toPass({ timeout: 45_000 })
  await expect(page.getByText('Stopping the run.')).toBeVisible({ timeout: 30_000 })
  // The fake Hermes does not confirm the stop: the card to stop waiting appears in the chat.
  const card = page.getByRole('region', { name: 'Not confirmed as ended' })
  await expect(async () => {
    const before = await card.count()
    if (before > 0) {
      await card.first().getByRole('checkbox').first().check()
      await card.first().getByRole('button', { name: 'Stop waiting for this' }).click()
      await expect(card).toHaveCount(before - 1, { timeout: 4000 })
    }
    expect(await card.count()).toBe(0)
  }).toPass({ timeout: 45_000 })
  await expect(page.getByText('The run was stopped.')).toBeVisible({ timeout: 60_000 })
  // See full details leaves for the admin view's Flow for this run, and the browser remembers it.
  await page.getByRole('button', { name: 'See full details' }).click()
  await expect(page).toHaveURL(/\/now\/flow\/.+/)
  await expect(page.locator('[data-node="lead"]')).toBeVisible()
  await page.goto('/')
  await expect(page).toHaveURL(/\/now/)
})

test('/orchestrate <goal> opens the compact dialog with the goal filled in', async ({ page }) => {
  await pair(page)
  await page.goto('/u')
  await page.getByRole('link', { name: 'New chat' }).click()
  await page.getByRole('combobox', { name: /^Message/ }).fill('/orchestrate Plan the launch week')
  await page.getByRole('combobox', { name: /^Message/ }).press('Enter')
  const dialog = page.getByRole('dialog', { name: 'New orchestration' })
  await expect(dialog.getByRole('textbox', { name: 'Goal' })).toHaveValue('Plan the launch week')
  await dialog.getByRole('button', { name: 'Close' }).click()
  await expect(dialog).toBeHidden()
})

test('switching views both ways is remembered by this browser', async ({ page }) => {
  await pair(page)
  await page.goto('/now')
  await page.getByRole('button', { name: 'Your account' }).click()
  await page.getByRole('menuitem', { name: 'Switch to user view' }).click()
  await expect(page).toHaveURL(/\/u(\/|$)/)
  await page.goto('/')
  await expect(page).toHaveURL(/\/u(\/|$)/)
  await page.getByRole('button', { name: 'Your account' }).click()
  await page.getByRole('menuitem', { name: 'Switch to admin view' }).click()
  await expect(page).toHaveURL(/\/now$/)
  await page.goto('/')
  await expect(page).toHaveURL(/\/now$/)
  // The same choice is in the admin view's own menu for a room: it opens that room in the user view.
  const made = await makeRoom(page, 'sw')
  await page.goto(`/chat/${made.id}`)
  await page.getByRole('button', { name: 'Your account' }).click()
  await page.getByRole('menuitem', { name: 'Switch to user view' }).click()
  await expect(page).toHaveURL(`/u/rooms/${made.id}`)
})

test('the per-browser guard asks for the security password before the admin view opens', async ({
  page,
}) => {
  await pair(page)
  // The security password guards sensitive actions; set it if this server has none yet.
  await page.request.put('/api/session/security/password', {
    headers: web,
    data: { password: SECURITY_PASSWORD },
  })
  await page.goto('/settings')
  const guard = page.getByRole('checkbox', { name: /Ask for the security password/ })
  await guard.check()
  const form = page.getByRole('form', { name: 'Turn on the password check' })
  await form.getByLabel('Security password').fill('not the password')
  await form.getByRole('button', { name: 'Turn on' }).click()
  await expect(
    page.getByRole('alert').filter({ hasText: 'not the security password' }),
  ).toBeVisible()
  await form.getByLabel('Security password').fill(SECURITY_PASSWORD)
  await form.getByRole('button', { name: 'Turn on' }).click()
  await expect(form).toBeHidden()
  await expect(guard).toBeChecked()
  await page.reload()
  await expect(page.getByRole('checkbox', { name: /Ask for the security password/ })).toBeChecked()
  // Switch to the user view, then back: the admin view needs the password now.
  await page.getByRole('button', { name: 'Your account' }).click()
  await page.getByRole('menuitem', { name: 'Switch to user view' }).click()
  await expect(page).toHaveURL(/\/u(\/|$)/)
  await page.getByRole('button', { name: 'Your account' }).click()
  await page.getByRole('menuitem', { name: 'Switch to admin view' }).click()
  const dialog = page.getByRole('dialog', { name: 'Open the admin view' })
  await dialog.getByLabel('Security password').fill('still not it')
  await dialog.getByRole('button', { name: 'Open admin view' }).click()
  await expect(dialog.getByRole('alert')).toHaveText('That is not the security password.')
  await expect(page).toHaveURL(/\/u(\/|$)/)
  await dialog.getByLabel('Security password').fill(SECURITY_PASSWORD)
  await dialog.getByRole('button', { name: 'Open admin view' }).click()
  await expect(page).toHaveURL(/\/now$/)
  // Turning it off again needs nothing.
  await page.goto('/settings')
  await page.getByRole('checkbox', { name: /Ask for the security password/ }).uncheck()
  await expect(
    page.getByRole('checkbox', { name: /Ask for the security password/ }),
  ).not.toBeChecked()
})

test.describe('phone width', () => {
  test.use({ viewport: { width: 390, height: 800 } })
  test('the conversations are a drawer and nothing scrolls sideways', async ({ page }) => {
    await pair(page)
    const made = await makeRoom(page, 'ph')
    await page.goto(`/u/rooms/${made.id}`)
    const drawer = page.getByRole('dialog', { name: 'Conversations' })
    await expect(drawer).toHaveCount(0)
    await page.getByRole('button', { name: 'Conversations' }).click()
    await expect(drawer).toBeVisible()
    await expect(drawer.getByRole('link', { name: 'New chat' })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(drawer).toHaveCount(0)
    await page.getByRole('button', { name: 'Conversations' }).click()
    await drawer.getByRole('link', { name: 'New chat' }).click()
    await expect(
      page.getByRole('heading', { name: 'What would you like to work on?' }),
    ).toBeVisible()
    await expect(page.getByRole('dialog', { name: 'Conversations' })).toHaveCount(0)
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth - window.innerWidth),
    ).toBeLessThanOrEqual(1)
  })
})
