import { expect, test, type Page } from '@playwright/test'
import { sampleProfile } from '../apps/server/test/helpers/tar.ts'
import { holdLockPerTest } from './locks.ts'
import { pair } from './pair.ts'

// PLAN 11.8c: every Add an agent path on the bold shell, against the fake adapter. The demo roster is shared by specs,
// so each test takes the roster lock and removes what it created.
test.use({ reducedMotion: 'reduce' })
holdLockPerTest('roster')
test.describe.configure({ mode: 'serial' })

const sizes = [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
] as const

const suffix = () => Date.now().toString(36)

async function deleteProfile(page: Page, id: string) {
  await page.evaluate(async (agentId) => {
    const headers = { 'content-type': 'application/json', 'X-Score-Client': 'web' }
    const preview = await fetch('/api/agents/preview', {
      method: 'POST',
      headers,
      body: JSON.stringify({ kind: 'delete', agentId }),
    })
    if (!preview.ok) return
    const { hash } = (await preview.json()) as { hash: string }
    await fetch(`/api/agents/${encodeURIComponent(agentId)}`, {
      method: 'DELETE',
      headers: { ...headers, 'Idempotency-Key': crypto.randomUUID() },
      body: JSON.stringify({ typedName: agentId, previewHash: hash }),
    })
  }, id)
}

async function deleteCoding(page: Page, id: string) {
  await page.evaluate(async (agentId) => {
    await fetch(`/api/coding-agents/${encodeURIComponent(agentId)}`, {
      method: 'DELETE',
      headers: { 'X-Score-Client': 'web' },
    })
  }, id)
}

async function openAdd(page: Page, width: number) {
  await page.setViewportSize({ width, height: width === 390 ? 844 : 900 })
  await pair(page)
  await page.goto('/b/team?add=agent')
  const dialog = page.getByRole('dialog', { name: 'Add an agent' })
  await expect(dialog.getByRole('heading', { name: 'Add an agent' })).toBeVisible()
  return dialog
}

for (const viewport of sizes) {
  test(`new agent: shape, colour, preview and setup at ${viewport.width}×${viewport.height}`, async ({
    page,
  }) => {
    test.setTimeout(120_000)
    const id = `new-${suffix()}`
    const dialog = await openAdd(page, viewport.width)
    let created = false
    try {
      const shapeGroup = dialog.getByRole('radiogroup', { name: 'Shape' })
      await expect(shapeGroup.getByRole('radio')).toHaveCount(22)
      const colourGroup = dialog.getByRole('radiogroup', { name: 'Colour' })
      const taken = colourGroup.locator('input[type=radio]:disabled')
      await expect(taken.first()).toBeVisible()
      expect(await taken.count()).toBeGreaterThan(0)
      expect(await taken.first().isChecked()).toBe(false)

      await dialog.getByLabel('Name').fill(id)
      await dialog.getByLabel('What does it do?').fill('Finds sources and writes a short summary.')
      await dialog.getByLabel('Model', { exact: true }).fill('fake-model')
      await shapeGroup.getByRole('radio', { name: 'star' }).click()
      const free = colourGroup.locator('input[type=radio]:not(:disabled)').first()
      const chosen = await free.getAttribute('data-colour')
      await free.check()

      const preview = dialog.getByRole('img', { name: `${id}, star` })
      await expect(preview).toBeVisible()
      expect(
        await preview.evaluate((element) =>
          getComputedStyle(element).getPropertyValue('--glyph-color').trim(),
        ),
      ).toBe(chosen)

      await dialog.getByRole('button', { name: 'Preview changes' }).click()
      await expect(dialog.getByRole('heading', { name: 'Review changes' })).toBeVisible()
      // The server's preview of what creating the profile does (fake adapter wording).
      await expect(
        dialog.getByRole('region', { name: 'Review changes' }).getByRole('listitem').first(),
      ).toBeVisible()
      await dialog.getByRole('button', { name: `Add ${id}` }).click()
      await expect(dialog.getByRole('heading', { name: 'Setting up' })).toBeVisible()
      await expect(dialog.getByRole('heading', { name: `${id} joined the team` })).toBeVisible({
        timeout: 20_000,
      })
      await expect(dialog.getByText(/fake-model/)).toBeVisible()
      created = true
    } finally {
      if (created) await deleteProfile(page, id)
    }
  })

  test(`copy from builder: inherited preview and confirmation at ${viewport.width}×${viewport.height}`, async ({
    page,
  }) => {
    test.setTimeout(120_000)
    const id = `copy-${suffix()}`
    const dialog = await openAdd(page, viewport.width)
    let created = false
    try {
      await dialog.getByLabel('Name').fill(id)
      await dialog.getByLabel('What does it do?').fill('Reviews the queue compared by builder.')
      await dialog.getByLabel('Model', { exact: true }).fill('fake-model')
      await dialog.getByLabel('Copy from').selectOption('builder')
      await dialog.getByRole('button', { name: 'Preview changes' }).click()

      await expect(dialog.getByRole('heading', { name: 'Review changes' })).toBeVisible()
      await expect(dialog.getByText('Memories', { exact: true })).toBeVisible()
      await expect(dialog.getByText('Skills', { exact: true })).toBeVisible()
      const add = dialog.getByRole('button', { name: `Add ${id}` })
      await expect(add).toBeDisabled()
      await dialog.getByRole('checkbox', { name: /what this agent inherits/ }).check()
      await expect(add).toBeEnabled()
      await add.click()
      await expect(dialog.getByRole('heading', { name: `${id} joined the team` })).toBeVisible({
        timeout: 20_000,
      })
      await expect(dialog.getByText(`copied from builder`)).toBeVisible()
      created = true
    } finally {
      if (created) await deleteProfile(page, id)
    }
  })

  test(`new agent on Docker: the write succeeds and the joined screen says what separated at ${viewport.width}×${viewport.height}`, async ({
    page,
  }) => {
    test.setTimeout(120_000)
    const id = `docker-${suffix()}`
    const dialog = await openAdd(page, viewport.width)
    let created = false
    try {
      await dialog.getByLabel('Name').fill(id)
      await dialog.getByLabel('What does it do?').fill('Runs builds in a container.')
      await dialog.getByLabel('Model', { exact: true }).fill('fake-model')
      await dialog.getByLabel('Works on').selectOption('docker')

      const write = page.waitForRequest(
        (request) =>
          request.method() === 'PUT' && request.url().endsWith(`/api/agents/${id}/runs-on`),
      )
      const answer = page.waitForResponse(
        (response) =>
          response.request().method() === 'PUT' &&
          response.url().endsWith(`/api/agents/${id}/runs-on`),
      )
      await dialog.getByRole('button', { name: 'Preview changes' }).click()
      await expect(dialog.getByRole('heading', { name: 'Review changes' })).toBeVisible()
      await dialog.getByRole('button', { name: `Add ${id}` }).click()

      expect(await (await write).postDataJSON()).toEqual({ backend: 'docker' })
      const runsOn = (await (await answer).json()) as {
        separated: 'no' | 'partly' | 'unknown'
        notes: string[]
      }
      expect(runsOn.separated).toBe('partly')
      await expect(dialog.getByRole('heading', { name: `${id} joined the team` })).toBeVisible({
        timeout: 20_000,
      })
      await expect(dialog.getByText(/Docker · Partly separated/)).toBeVisible()
      await expect(dialog.getByText(runsOn.notes[0]!)).toBeVisible()
      await expect(dialog.getByRole('link', { name: 'Where it works' })).toHaveAttribute(
        'href',
        `/b/team/${id}#agent-where`,
      )
      created = true
    } finally {
      if (created) await deleteProfile(page, id)
    }
  })

  test(`a 409 on Docker: the reason and Continue path say where the agent runs at ${viewport.width}×${viewport.height}`, async ({
    page,
  }) => {
    test.setTimeout(120_000)
    const id = `no-docker-${suffix()}`
    const dialog = await openAdd(page, viewport.width)
    let created = false
    const reason = 'Docker isn’t installed or its daemon is not running.'
    await page.route('**/api/agents/*/runs-on', async (route) => {
      if (route.request().method() !== 'PUT') return route.continue()
      expect(route.request().postDataJSON()).toEqual({ backend: 'docker' })
      await route.fulfill({
        status: 409,
        contentType: 'application/json',
        body: JSON.stringify({ error: { code: 'backend_unavailable', message: reason } }),
      })
    })
    try {
      await dialog.getByLabel('Name').fill(id)
      await dialog.getByLabel('What does it do?').fill('Runs builds in a container.')
      await dialog.getByLabel('Model', { exact: true }).fill('fake-model')
      await dialog.getByLabel('Works on').selectOption('docker')
      await dialog.getByRole('button', { name: 'Preview changes' }).click()
      await expect(dialog.getByRole('heading', { name: 'Review changes' })).toBeVisible()
      await dialog.getByRole('button', { name: `Add ${id}` }).click()

      await expect(dialog.getByRole('alert').getByText(reason)).toBeVisible()
      await dialog.getByRole('button', { name: 'Continue on this machine' }).click()
      await expect(dialog.getByRole('heading', { name: `${id} joined the team` })).toBeVisible()
      await expect(dialog.getByText(`Runs on this machine as you: ${reason}`)).toBeVisible()
      await expect(dialog.getByRole('link', { name: 'Where it works' })).toHaveAttribute(
        'href',
        `/b/team/${id}#agent-where`,
      )
      created = true
    } finally {
      if (created) await deleteProfile(page, id)
      await page.unroute('**/api/agents/*/runs-on')
    }
  })

  test(`import a profile: upload progress, credentials and done at ${viewport.width}×${viewport.height}`, async ({
    page,
  }) => {
    test.setTimeout(120_000)
    const id = `import-${suffix()}`
    const dialog = await openAdd(page, viewport.width)
    let created = false
    try {
      await dialog.getByRole('radio', { name: /Bring in a Hermes profile/ }).click()
      await page.route('**/api/agents/imports', async (route) => {
        if (route.request().method() !== 'POST') return route.continue()
        await new Promise((resolve) => setTimeout(resolve, 2000))
        await route.continue()
      })
      await dialog.getByLabel('Profile export').setInputFiles({
        name: 'scout.tar.gz',
        mimeType: 'application/gzip',
        buffer: sampleProfile('scout', [{ name: 'scout/.env', body: 'TOKEN=never-shown' }]),
      })
      await expect(
        dialog.getByRole('status').filter({ hasText: /Uploading|Checking/ }),
      ).toBeVisible()

      // While the upload runs, Escape and the backdrop do nothing; the X asks before discarding it.
      await page.keyboard.press('Escape')
      await expect(dialog).toBeVisible()
      await page.mouse.click(5, 5)
      await expect(dialog).toBeVisible()
      await dialog.getByRole('button', { name: 'Close' }).click()
      const confirm = dialog.getByRole('alertdialog', { name: 'Close while it’s still running?' })
      await expect(confirm).toBeVisible()
      await expect(confirm).toHaveAttribute('data-protected', 'block')
      await confirm.getByRole('button', { name: 'Keep waiting' }).click()

      await expect(dialog.getByRole('heading', { name: 'In this archive' })).toBeVisible()
      await expect(dialog.getByText('example/model-1')).toBeVisible()
      await expect(dialog.getByText(/\.env/)).toBeVisible()
      await expect(dialog.getByText('never-shown')).toHaveCount(0)

      await dialog.getByLabel('Name').fill(id)
      const importButton = dialog.getByRole('button', { name: 'Import agent' })
      await expect(importButton).toBeDisabled()
      await dialog.getByRole('checkbox', { name: /credential files/ }).check()
      await expect(importButton).toBeEnabled()
      await importButton.click()
      await expect(dialog.getByRole('heading', { name: 'Importing agent' })).toBeVisible()
      await expect(dialog.getByRole('heading', { name: `${id} joined the team` })).toBeVisible({
        timeout: 20_000,
      })
      await expect(dialog.getByText('Hermes agent, imported from an archive')).toBeVisible()
      created = true
    } finally {
      if (created) await deleteProfile(page, id)
    }
  })

  test(`coding tool: install state, version check and acknowledgement at ${viewport.width}×${viewport.height}`, async ({
    page,
  }) => {
    test.setTimeout(120_000)
    const id = `coder-${suffix()}`
    const dialog = await openAdd(page, viewport.width)
    let created = false
    const runsOnWrites: string[] = []
    page.on('request', (request) => {
      if (request.method() === 'PUT' && request.url().includes('/runs-on'))
        runsOnWrites.push(request.url())
    })
    try {
      await dialog.getByRole('radio', { name: /A coding tool/ }).click()
      await expect(dialog.getByText(/Installed · version 2\.1\.295/)).toBeVisible()
      await expect(dialog.getByText(/tested by Score/)).toBeVisible()
      await expect(dialog.getByLabel('Works on')).toHaveCount(0)
      await expect(dialog.getByText('Runs on this machine as you.')).toBeVisible()
      const checked = page.waitForResponse(
        (response) =>
          response.url().endsWith('/api/coding-agents/runtimes') &&
          response.request().method() === 'GET',
      )
      await dialog.getByRole('button', { name: 'Check version again' }).click()
      await checked

      await dialog.getByRole('radio', { name: 'Codex' }).click()
      const ack = dialog.getByRole('checkbox', { name: /can read any file/ })
      await expect(ack).toBeVisible()
      await expect(dialog.locator('label.coding-acknowledge')).toHaveAttribute(
        'data-protected',
        'any',
      )
      await dialog.getByRole('radio', { name: /Full access/ }).check()
      await expect(dialog.locator('label', { hasText: 'Security password' })).toHaveAttribute(
        'data-protected',
        'any',
      )
      await dialog.getByRole('radio', { name: /Workspace write/ }).check()

      await dialog.getByLabel('Name').fill(id)
      await dialog.getByLabel('What does it do?').fill('Reviews build scripts.')
      await ack.check()
      const add = dialog.getByRole('button', { name: 'Add coding agent' })
      await expect(add).toBeEnabled()
      await add.click()
      await expect(dialog.getByRole('heading', { name: `${id} joined the team` })).toBeVisible({
        timeout: 30_000,
      })
      await expect(dialog.getByText(/Codex/)).toBeVisible()
      await expect(dialog.getByText(/workspace write/)).toBeVisible()
      expect(runsOnWrites).toEqual([])
      created = true
    } finally {
      if (created) await deleteCoding(page, id)
    }
  })
}

for (const viewport of sizes) {
  test(`a blocked preview says why Add is off at ${viewport.width}×${viewport.height}`, async ({
    page,
  }) => {
    const blocker = 'A pinned bridge installation URL has not been configured.'
    await page.route('**/api/agents/preview', async (route) => {
      const real = await route.fetch()
      const body = (await real.json()) as Record<string, unknown>
      await route.fulfill({ response: real, json: { ...body, blockers: [blocker] } })
    })
    const dialog = await openAdd(page, viewport.width)
    await dialog.getByLabel('Name').fill(`blocked-${suffix()}`)
    await dialog.getByLabel('What does it do?').fill('Checks the blocker is shown.')
    await dialog.getByLabel('Model', { exact: true }).fill('fake-model')
    await dialog.getByRole('button', { name: 'Preview changes' }).click()
    const why = dialog.getByRole('alert').filter({ hasText: blocker })
    await expect(why).toBeVisible()
    await expect(why).toContainText('SCORE_BRIDGE_INSTALL_URL')
    await expect(dialog.getByRole('button', { name: /^Add blocked-/ })).toBeDisabled()
  })
}

for (const viewport of sizes) {
  test(`reusing a removed agent’s name needs its own tick at ${viewport.width}×${viewport.height}`, async ({
    page,
  }) => {
    const sent: Record<string, unknown>[] = []
    await page.route('**/api/agents/preview', async (route) => {
      const real = await route.fetch()
      const body = (await real.json()) as Record<string, unknown>
      await route.fulfill({ response: real, json: { ...body, reusesName: true } })
    })
    await page.route('**/api/agents', async (route) => {
      if (route.request().method() !== 'POST') return route.fallback()
      sent.push(route.request().postDataJSON() as Record<string, unknown>)
      await route.fulfill({
        status: 409,
        json: { error: { code: 'conflict', message: 'Stopped by the test.' } },
      })
    })
    const dialog = await openAdd(page, viewport.width)
    const id = `again-${suffix()}`
    await dialog.getByLabel('Name').fill(id)
    await dialog.getByLabel('What does it do?').fill('Checks the reuse tick.')
    await dialog.getByLabel('Model', { exact: true }).fill('fake-model')
    await dialog.getByRole('button', { name: 'Preview changes' }).click()
    const tick = dialog.getByRole('checkbox', { name: /Use the name .* again/ })
    await expect(tick).toBeVisible()
    await expect(dialog.getByRole('alert').filter({ hasText: 'again.”' })).toBeVisible()
    const add = dialog.getByRole('button', { name: /^Add again-/ })
    await expect(add).toBeDisabled()
    await tick.check()
    await expect(add).toBeEnabled()
    await add.click()
    await expect.poll(() => sent.length).toBe(1)
    expect(sent[0]).toMatchObject({ confirmReuse: true })
  })
}
