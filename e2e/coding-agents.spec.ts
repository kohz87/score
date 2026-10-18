import { DatabaseSync } from 'node:sqlite'
import { join } from 'node:path'
import { expect, test, type Locator, type Page } from '@playwright/test'
import { pair } from './pair.ts'

// Coding agents (PLAN 7.2) against the fake adapter and a fake CLI script that prints hand-made fixtures: no model is
// called and no real CLI is started.
async function api(page: Page, path: string, body: object): Promise<unknown> {
  return page.evaluate(
    async ([url, payload]) => {
      const response = await fetch(url as string, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'X-Score-Client': 'web' },
        body: JSON.stringify(payload),
      })
      return response.json()
    },
    [`/api/${path}`, body],
  )
}

// Where the quota-meter screenshots go, when asked for (SCORE_QUOTA_SHOTS=<folder>).
async function shot(target: Locator, name: string): Promise<void> {
  const folder = process.env['SCORE_QUOTA_SHOTS']
  if (folder) await target.screenshot({ path: join(folder, name) })
}

test('add a coding agent, give it work in a room, stop one turn, see it in Reports and Watch', async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000)
  const suffix = Date.now().toString(36)
  const id = `coder-${suffix}`
  const roomName = `coding-${suffix}`
  await pair(page)

  // Team › Add agent › Coding agent
  await page.goto('/team')
  await page.getByRole('button', { name: 'Add agent' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('radio', { name: /Coding agent/ }).check()
  await expect(dialog.getByLabel('Kind of coding agent')).toHaveValue('claude-code')
  await expect(dialog).toContainText('Uses your Claude plan quota')
  await expect(dialog.getByRole('note')).toContainText(
    'Score blocks your Hermes, Score and SSH folders',
  )
  // Model picker (PLAN 8.5): Claude Code has no listing command, so its list is the documented aliases.
  const claudeModel = dialog.getByRole('combobox', { name: 'Model' })
  await expect(claudeModel.locator('option')).toHaveText([
    'CLI default',
    'Fable',
    'Opus',
    'Sonnet',
    'Other…',
  ])
  await expect(claudeModel).toHaveValue('')
  await dialog.getByLabel(/Agent name/).fill(id)
  await dialog.getByRole('radio', { name: /Full access/ }).check()
  await expect(dialog.getByText(/turns the CLI’s own sandbox off/)).toBeVisible()
  await dialog.getByRole('radio', { name: /Workspace write/ }).check()
  await dialog.screenshot({ path: testInfo.outputPath('coding-add.png') })
  await dialog.getByRole('button', { name: 'Add coding agent' }).click()
  await expect(dialog.getByRole('heading', { name: `${id} joined the team` })).toBeVisible()
  await dialog.getByRole('link', { name: /^Open / }).click()
  const card = page.getByRole('tabpanel')
  await expect(card).toContainText('Claude Code 2.1.295 · Ready')
  await expect(page.getByRole('tab', { name: 'Skills' })).toHaveCount(0)
  await page.screenshot({ path: testInfo.outputPath('coding-overview.png') })

  // A room, an @mention, a streamed reply with tool cards.
  await api(page, 'rooms', { name: roomName, leadAgentId: 'lead' })
  await page.goto('/chat')
  await page
    .getByRole('navigation', { name: 'Rooms' })
    .getByRole('link', { name: new RegExp(roomName) })
    .click({ timeout: 15_000 })
  const history = page.getByRole('region', { name: 'Message history' })
  const composer = page.getByRole('combobox', { name: /^Message/ })
  await composer.fill(`@${id} please add a greeting`)
  await composer.press('Enter')
  const reply = history
    .getByRole('article')
    .filter({ hasText: 'Created hello.txt and changed it.' })
  await expect(reply).toBeVisible({ timeout: 30_000 })
  await expect(reply).toContainText('ls -la')
  await page.screenshot({ path: testInfo.outputPath('coding-room.png') })

  // Stop a long turn.
  await composer.fill(`@${id} [fixture:slow] take your time`)
  await composer.press('Enter')
  const slow = history.getByRole('article').filter({ hasText: 'Working on' })
  const stop = slow.getByRole('button', { name: /^Stop reply from/ })
  await expect(stop).toBeVisible({ timeout: 30_000 })
  await stop.click()
  await expect(
    history.getByRole('article').filter({ hasText: 'This run was stopped.' }),
  ).toBeVisible({
    timeout: 30_000,
  })

  // Reports: Claude Code's figure is an estimate.
  await page.goto('/reports')
  const row = page.getByRole('row', { name: new RegExp(`^${id} `) })
  await expect(row).toContainText('estimated', { timeout: 15_000 })

  // Watch: frames came from the parsed events.
  await page.goto(`/now/watch/${encodeURIComponent(id)}`)
  await expect(page.getByText(/Ran ls -la/).first()).toBeVisible({ timeout: 15_000 })

  // Quota meters (PLAN 8.1): the turn's own rate-limit record, as "% left" with when Score saw it.
  await page.goto(`/team/${encodeURIComponent(id)}`)
  const meters = page.getByRole('tabpanel').getByRole('group', {
    name: 'Claude Code limits',
  })
  await expect(meters.getByRole('meter', { name: '5 hours left' })).toHaveAttribute(
    'aria-valuenow',
    '94',
  )
  await expect(meters.getByRole('meter', { name: 'week left' })).toHaveAttribute(
    'aria-valuenow',
    '22',
  )
  await expect(meters).toContainText('As of')
  await shot(meters, 'meters-claude-code.png')

  // Clean up so other specs see the usual team.
  await page.goto(`/team/${encodeURIComponent(id)}`)
  page.once('dialog', (confirm) => void confirm.accept())
  await page.getByRole('button', { name: 'Remove agent' }).click()
  await expect(page).toHaveURL(/\/team$/)
})

test('Antigravity: warning, quota, unverified level disabled, a turn with tool cards and a refusal card', async ({
  page,
}, testInfo) => {
  test.setTimeout(120_000)
  const suffix = Date.now().toString(36)
  const id = `agy-${suffix}`
  const roomName = `antigravity-room-${suffix}`
  await pair(page)
  await page.goto('/team')
  await page.getByRole('button', { name: 'Add agent' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('radio', { name: /Coding agent/ }).check()
  await dialog.getByLabel('Kind of coding agent').selectOption('antigravity')
  await expect(dialog).toContainText('browse the web, generate images')
  await expect(dialog.getByRole('group', { name: 'Antigravity limits' })).toContainText(
    'Gemini Models 5 hours 87% left',
  )
  await expect(dialog.getByRole('radio', { name: /Full access/ })).toBeDisabled()
  await expect(dialog).toContainText('not verified for agy yet')
  // Model picker (PLAN 8.5): `agy models`, grouped by family, with CLI default first and Other… last.
  const model = dialog.getByRole('combobox', { name: 'Model' })
  await expect(model.locator('option').first()).toHaveText('CLI default')
  await expect(model.locator('option').last()).toHaveText('Other…')
  await expect(model.locator('optgroup')).toHaveCount(4)
  await expect(model.locator('optgroup[label="Gemini 4 Argon"] option')).toHaveText([
    'Gemini 4 Argon (Medium)',
    'Gemini 4 Argon (High)',
    'Gemini 4 Argon (Low)',
  ])
  await model.selectOption('gemini-4-argon-high')
  await expect(dialog.getByLabel('Model name')).toHaveCount(0)
  await model.selectOption('__other__')
  await dialog.getByLabel('Model name').fill('some-other-model')
  await model.selectOption('gemini-4-argon-high')
  await expect(dialog.getByLabel('Model name')).toHaveCount(0)
  // The screenshot shows the list opened (a native menu isn't drawn in a capture, so it is shown as a list box).
  const pickerShots = process.env['SCORE_PICKER_SHOTS']
  if (pickerShots) {
    await model.evaluate((element) => element.setAttribute('size', '9'))
    // With a size it is a list box, no longer a combobox.
    const opened = dialog.getByRole('listbox', { name: 'Model' })
    await opened.scrollIntoViewIfNeeded()
    await dialog.screenshot({ path: join(pickerShots, 'picker.png') })
    await opened.evaluate((element) => element.removeAttribute('size'))
  }
  await dialog.getByLabel(/Agent name/).fill(id)
  await dialog.getByRole('radio', { name: /Read only/ }).check()
  const add = dialog.getByRole('button', { name: 'Add coding agent' })
  // Read only keeps Antigravity in its sandbox: no read acknowledgement is asked, so Add is ready at once.
  await expect(add).toBeEnabled()
  await expect(dialog.getByRole('checkbox', { name: /can read any file/ })).toHaveCount(0)
  await dialog.screenshot({ path: testInfo.outputPath('agy-add.png') })
  await dialog.getByLabel('Kind of coding agent').scrollIntoViewIfNeeded()
  await dialog.screenshot({ path: testInfo.outputPath('agy-add-top.png') })
  await add.click()
  await expect(dialog.getByRole('heading', { name: `${id} joined the team` })).toBeVisible()
  await dialog.getByRole('link', { name: /^Open / }).click()
  const card = page.getByRole('tabpanel')
  await expect(card).toContainText('Antigravity 1.3.3 · Ready')
  await expect(card).toContainText('Gemini Models')
  const agyMeters = card.getByRole('group', { name: 'Antigravity limits' })
  await expect(
    agyMeters.getByRole('meter', { name: 'Gemini Models, 5 hours left' }),
  ).toHaveAttribute('aria-valuenow', '87')
  await expect(agyMeters).toContainText('Claude and GPT models, week')
  await expect(agyMeters).toContainText('75% left')
  await expect(agyMeters).toContainText(/resets .*(am|pm)/)
  await page.screenshot({ path: testInfo.outputPath('agy-overview.png') })
  await shot(agyMeters, 'meters-antigravity.png')

  // The chosen model is the agent's setting; an unknown one comes back as Other… with its name.
  await card.getByRole('button', { name: 'Change model' }).click()
  const settingsModel = card.getByRole('combobox', { name: 'Model' })
  await expect(settingsModel).toHaveValue('gemini-4-argon-high')
  await settingsModel.selectOption('__other__')
  await card.getByLabel('Model name').fill('retired-model-1')
  await card.getByRole('button', { name: 'Save' }).click()
  await expect(async () => {
    await page.reload()
    await expect(page.getByRole('region', { name: 'Model' })).toContainText('retired-model-1')
  }).toPass({ timeout: 15_000 })

  await api(page, 'rooms', { name: roomName, leadAgentId: 'lead' })
  await page.goto('/chat')
  await page
    .getByRole('navigation', { name: 'Rooms' })
    .getByRole('link', { name: new RegExp(roomName) })
    .click({ timeout: 15_000 })
  const history = page.getByRole('region', { name: 'Message history' })
  const composer = page.getByRole('combobox', { name: /^Message/ })
  await composer.fill(`@${id} [fixture:denied] list the files`)
  await composer.press('Enter')
  const refused = history.getByRole('article').filter({ hasText: 'Antigravity refused' })
  await expect(refused).toBeVisible({ timeout: 30_000 })
  await expect(refused).toContainText('RunCommand')
  await composer.fill(`@${id} [fixture:basic] please update the notes`)
  await composer.press('Enter')
  const reply = history
    .getByRole('article')
    .filter({ hasText: 'Updated notes.txt and checked the docs.' })
  await expect(reply).toBeVisible({ timeout: 30_000 })
  await expect(reply).toContainText('ls -la')
  await page.screenshot({ path: testInfo.outputPath('agy-room.png') })

  await page.goto(`/now/watch/${encodeURIComponent(id)}`)
  await expect(page.getByText(/Ran ls -la/).first()).toBeVisible({ timeout: 15_000 })

  await page.goto(`/team/${encodeURIComponent(id)}`)
  page.once('dialog', (confirm) => void confirm.accept())
  await page.getByRole('button', { name: 'Remove agent' }).click()
  await expect(page).toHaveURL(/\/team$/)
})

test('Codex: the meters come from the log of the run Score started, and say nothing before the first reply', async ({
  page,
}) => {
  test.setTimeout(90_000)
  const suffix = Date.now().toString(36)
  const id = `cx-${suffix}`
  await pair(page)
  const created = await api(page, 'coding-agents', {
    id,
    name: id,
    runtime: 'codex',
    style: { color: '#19C39A', shape: 'hexagon' },
    permission: 'read-only',
    acknowledgeReads: true,
  })
  expect(created).toMatchObject({ id })
  await page.goto(`/team/${encodeURIComponent(id)}`)
  const card = page.getByRole('tabpanel')
  await expect(card).toContainText('Codex reports its limits after its first reply')
  await api(page, 'rooms', { name: `codex-${suffix}`, leadAgentId: 'lead' })
  await page.goto('/chat')
  await page
    .getByRole('navigation', { name: 'Rooms' })
    .getByRole('link', { name: new RegExp(`codex-${suffix}`) })
    .click({ timeout: 15_000 })
  const composer = page.getByRole('combobox', { name: /^Message/ })
  await composer.fill(`@${id} look around`)
  await composer.press('Enter')
  await expect(
    page.getByRole('region', { name: 'Message history' }).getByRole('article').filter({
      hasText: 'Updated notes.txt and added new.txt.',
    }),
  ).toBeVisible({ timeout: 30_000 })
  await page.goto(`/team/${encodeURIComponent(id)}`)
  const meters = card.getByRole('group', { name: 'Codex limits' })
  await expect(meters.getByRole('meter', { name: '5 hours left' })).toHaveAttribute(
    'aria-valuenow',
    '88',
  )
  await expect(meters.getByRole('meter', { name: 'week left' })).toHaveAttribute(
    'aria-valuenow',
    '59',
  )
  await shot(meters, 'meters-codex.png')
  page.once('dialog', (confirm) => void confirm.accept())
  await page.getByRole('button', { name: 'Remove agent' }).click()
  await expect(page).toHaveURL(/\/team$/)
})

test('Release: a coding agent held for programs Score can’t attribute is released on its page, with an audit row and nothing signalled', async ({
  page,
}) => {
  test.setTimeout(90_000)
  const id = `held-${Date.now().toString(36)}`
  await pair(page)
  await page.goto('/team')
  await page.getByRole('button', { name: 'Add agent' }).click()
  const dialog = page.getByRole('dialog')
  await dialog.getByRole('radio', { name: /Coding agent/ }).check()
  await dialog.getByLabel(/Agent name/).fill(id)
  await dialog.getByRole('button', { name: 'Add coding agent' }).click()
  await expect(dialog.getByRole('heading', { name: `${id} joined the team` })).toBeVisible()
  await dialog.getByRole('link', { name: /^Open / }).click()
  const card = page.getByRole('tabpanel')
  await expect(card).toContainText('Ready')
  await expect(card.getByRole('button', { name: 'Release agent' })).toHaveCount(0)

  // What a restart leaves behind when leftover programs can't be tied to the run: a held record, marked unclear.
  // The pid is far beyond any real one and is never signalled (Release only deletes the record).
  const home = process.env['SCORE_E2E_HOME']
  if (!home) throw new Error('SCORE_E2E_HOME is not set')
  const db = new DatabaseSync(join(home, 'home', 'score.db'))
  db.exec('PRAGMA busy_timeout = 5000')
  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO runs (id, profile, origin, score_turn_id, status, started_at, updated_at, runtime)
     VALUES (?, ?, 'score', ?, 'interrupted', ?, ?, 'claude-code')`,
  ).run(`cr_${id}`, id, `turn-${id}`, now, now)
  db.prepare(
    `INSERT INTO coding_processes (run_id, pid, pgid, start_time, boot_id, created_at, unresolved, unobservable)
     VALUES (?, 2147483000, 2147483000, '5', 'b', ?, 1, 1)`,
  ).run(`cr_${id}`, now)
  await page.reload()
  const release = card.getByRole('button', { name: 'Release agent' })
  await expect(release).toBeVisible({ timeout: 15_000 })
  await expect(card).toContainText('Score can’t tell whether these programs are its own')
  await expect(card).toContainText('ps -o pid,pgid,args -g 2147483000')
  await release.click()
  await expect(release).toHaveCount(0, { timeout: 15_000 })
  const rows = db.prepare('SELECT agent_id, run_id, pgid FROM coding_releases').all()
  expect(rows).toContainEqual({ agent_id: id, run_id: `cr_${id}`, pgid: 2147483000 })
  expect(db.prepare('SELECT 1 FROM coding_processes WHERE run_id = ?').get(`cr_${id}`)).toBe(
    undefined,
  )
  db.close()

  page.once('dialog', (confirm) => void confirm.accept())
  await page.getByRole('button', { name: 'Remove agent' }).click()
  await expect(page).toHaveURL(/\/team$/)
})
