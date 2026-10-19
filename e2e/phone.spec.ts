import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { once } from 'node:events'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'
import { pair } from './pair.ts'

const PASSWORD = 'correct horse battery'

test('the app is installable: manifest and icons are served, the worker is registered and never caches private data', async ({
  page,
  request,
}) => {
  await pair(page)
  const manifest = await request.get('/manifest.webmanifest')
  expect(manifest.ok()).toBe(true)
  expect(manifest.headers()['content-type']).toContain('application/manifest+json')
  const body = await manifest.json()
  expect(body).toMatchObject({ name: 'Score', display: 'standalone', start_url: '/now' })
  for (const icon of body.icons) expect((await request.get(icon.src)).ok()).toBe(true)
  expect((await request.get('/sw.js')).headers()['service-worker-allowed']).toBe('/')

  await page.goto('/now')
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  const scope = await page.evaluate(async () => (await navigator.serviceWorker.ready).scope)
  expect(scope).toBe(new URL('/', page.url()).href)
  // Wait for the worker to control the page, then check what it has stored: shell files only.
  await expect
    .poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null))
    .toBe(true)
  await page.reload()
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  const cached = await page.evaluate(async () => {
    const urls: string[] = []
    for (const name of await caches.keys())
      for (const entry of await (await caches.open(name)).keys())
        urls.push(new URL(entry.url).pathname)
    return urls
  })
  expect(cached).toContain('/offline.html')
  expect(cached.some((path) => path.startsWith('/assets/'))).toBe(true)
  expect(cached.filter((path) => /^\/(api|s|bridge|setup|pair)(\/|$)/.test(path))).toEqual([])
})

test('when Score cannot be reached the app shows the offline page and recovers on retry', async ({
  page,
  context,
}) => {
  await pair(page)
  await page.goto('/now')
  await page.evaluate(async () => navigator.serviceWorker.ready)
  await expect
    .poll(() => page.evaluate(() => navigator.serviceWorker.controller !== null))
    .toBe(true)
  await context.setOffline(true)
  await page.goto('/now').catch(() => {})
  await expect(page.getByRole('heading', { name: /Score can.t be reached/ })).toBeVisible()
  await context.setOffline(false)
  // The page also retries by itself when the connection returns, so the button may already be gone.
  await page
    .getByRole('button', { name: 'Try again' })
    .click({ timeout: 1000 })
    .catch(() => {})
  await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
  await expect(page.getByRole('heading', { name: /Score can.t be reached/ })).toHaveCount(0)
})

test('notifications ask for permission only on a click and then deliver through the worker', async ({
  page,
  context,
}) => {
  await context.grantPermissions(['notifications'], {
    origin:
      page.url() === 'about:blank'
        ? 'http://127.0.0.1:' + (process.env.SCORE_WEB_PORT ?? '5173')
        : page.url(),
  })
  await page.addInitScript(() => {
    // Headless Chromium answers the prompt but keeps reporting Notification.permission as not granted, so the
    // permission is faked here: this checks Score's flow (ask only on a click, deliver through the worker).
    let granted = false
    Object.defineProperty(Notification, 'permission', {
      get: () => (granted ? 'granted' : 'default'),
    })
    const original = async () => {
      granted = true
      return 'granted' as NotificationPermission
    }
    ;(window as unknown as { asked: number }).asked = 0
    // Headless Chromium doesn't list shown notifications back, so record what the worker is asked to show.
    ;(window as unknown as { shown: string[] }).shown = []
    const show = ServiceWorkerRegistration.prototype.showNotification
    ServiceWorkerRegistration.prototype.showNotification = function (title, options) {
      ;(window as unknown as { shown: string[] }).shown.push(title)
      return show.call(this, title, options)
    }
    Notification.requestPermission = () => {
      ;(window as unknown as { asked: number }).asked++
      return original()
    }
  })
  await pair(page)
  await page.goto('/settings/notifications')
  const section = page.getByRole('region', { name: 'Notifications' })
  await expect(section).toBeVisible()
  expect(await page.evaluate(() => (window as unknown as { asked: number }).asked)).toBe(0)
  await section.getByRole('button', { name: 'Turn on notifications on this device' }).click()
  await expect(
    section.getByRole('button', { name: 'Turn off notifications on this device' }),
  ).toBeVisible()
  expect(await page.evaluate(() => (window as unknown as { asked: number }).asked)).toBe(1)
  await section.getByRole('checkbox', { name: /A routine finished/ }).uncheck()
  await expect(section.getByRole('checkbox', { name: /A routine finished/ })).not.toBeChecked()
  await expect(section.getByRole('checkbox', { name: /Show message previews/ })).not.toBeChecked()
  await page.evaluate(async () => navigator.serviceWorker.ready)
  await section.getByRole('button', { name: 'Send a test notification' }).click()
  await expect
    .poll(() => page.evaluate(() => (window as unknown as { shown: string[] }).shown))
    .toContain('Score notifications work')
})

test.describe('on a phone', () => {
  test.use({ viewport: { width: 412, height: 915 }, hasTouch: true, isMobile: true })

  test('Enter adds a new line and the Send button sends', async ({ page }) => {
    await pair(page)
    await page.goto('/chat')
    await page
      .getByRole('navigation', { name: 'Rooms' })
      .getByRole('link', { name: /#activity-feed/ })
      .click({ timeout: 15_000 })
    const composer = page.getByRole('combobox', { name: /^Message/ })
    await expect(composer).toBeEnabled()
    const text = `Phone message ${Date.now()}`
    await composer.fill(text)
    await composer.press('Enter')
    await expect(composer).toHaveValue(`${text}\n`)
    await page.getByRole('button', { name: 'Send', exact: true }).click()
    await expect(composer).toHaveValue('')
    await expect(
      page
        .getByRole('region', { name: 'Message history' })
        .getByRole('article')
        .filter({ hasText: text }),
    ).toBeVisible()
  })
})

// Passkeys need a domain, a secure origin and a real (here: virtual) authenticator, so this runs its own HTTPS server
// that answers on localhost (a domain for WebAuthn) and on 127.0.0.1 (an IP address, where passkeys must be refused).
test.describe('passkeys over HTTPS', () => {
  test.use({ ignoreHTTPSErrors: true })
  const launcher = fileURLToPath(new URL('../scripts/score', import.meta.url))
  const loader = fileURLToPath(
    new URL('../apps/server/node_modules/tsx/dist/loader.mjs', import.meta.url),
  )
  const entry = fileURLToPath(new URL('../apps/server/src/index.ts', import.meta.url))

  test.beforeAll(() => {
    const dist = fileURLToPath(new URL('../apps/web/dist/index.html', import.meta.url))
    if (!existsSync(dist))
      execFileSync('pnpm', ['--filter', '@score/web', 'build'], {
        stdio: 'ignore',
        timeout: 120_000,
      })
  })

  test('register with the password, sign in with the passkey, refuse it on an IP address, remove it with the password', async ({
    page,
    context,
  }) => {
    const home = mkdtempSync(join(tmpdir(), 'score-passkey-e2e-'))
    const port = Number(process.env.SCORE_PORT ?? 8740) + 6
    const origin = `https://localhost:${port}`
    execFileSync(launcher, ['tls'], {
      env: { PATH: process.env.PATH!, HOME: home, SCORE_HOME: home, SCORE_HOST: '127.0.0.1' },
      stdio: 'ignore',
    })
    const child = spawn(process.execPath, ['--import', loader, entry], {
      env: {
        ...process.env,
        SCORE_HOME: home,
        SCORE_MODE: 'fake',
        SCORE_HOST: '127.0.0.1',
        SCORE_PORT: String(port),
        SCORE_REMOTE: '1',
        // The spec reads the pairing link from stdout, which a non-terminal only gets on request (audit wave 4).
        SCORE_PRINT_PAIR_LINK: '1',
        SCORE_TLS_CERT: join(home, 'tls', 'server.crt'),
        SCORE_TLS_KEY: join(home, 'tls', 'server.key'),
        SCORE_PUBLIC_ORIGINS: `${origin},https://127.0.0.1:${port}`,
        SCORE_BRIDGE_PORT: String(port + 1),
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()))
    child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()))
    try {
      await expect.poll(() => /\/pair#([\w-]+)/.exec(output)?.[1], { timeout: 30_000 }).toBeTruthy()
      const token = /\/pair#([\w-]+)/.exec(output)![1]!
      const cdp = await context.newCDPSession(page)
      await cdp.send('WebAuthn.enable')
      await cdp.send('WebAuthn.addVirtualAuthenticator', {
        options: {
          protocol: 'ctap2',
          transport: 'internal',
          hasResidentKey: true,
          hasUserVerification: true,
          isUserVerified: true,
          automaticPresenceSimulation: true,
        },
      })

      await page.goto(`${origin}/pair#${token}`)
      await page.getByRole('button', { name: 'Pair this browser' }).click()
      await expect(page.getByText('This browser is paired')).toBeVisible()
      await page.goto(`${origin}/settings/remote-access`)
      const setPassword = page.getByRole('form', { name: 'Set a security password' })
      await setPassword.getByLabel('New password (at least 8 characters)').fill(PASSWORD)
      await setPassword.getByLabel('New password again').fill(PASSWORD)
      await setPassword.getByRole('button', { name: 'Set password' }).click()
      await page.getByLabel('Security password', { exact: true }).fill(PASSWORD)

      const passkeys = page.getByRole('list', { name: 'Passkeys' })
      await page.getByLabel('Passkey name').fill('E2E phone')
      await page.getByRole('button', { name: 'Add a passkey' }).click()
      await expect(passkeys.getByText(/E2E phone, added/)).toBeVisible()
      await expect(page.getByText('Passkey added.')).toBeVisible()

      // Signing out leaves the passkey: the pairing page offers it, and it opens a normal session.
      await page.getByRole('button', { name: 'Log out this browser' }).click()
      await expect(page).toHaveURL(`${origin}/pair`)
      await page.getByRole('button', { name: 'Sign in with a passkey' }).click()
      await expect(page).toHaveURL(`${origin}/now`, { timeout: 15_000 })
      await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
      expect(await page.evaluate(async () => (await fetch('/api/agents')).status)).toBe(200)

      // On an IP address passkeys are not offered, and Settings explains why.
      await page.goto(`https://127.0.0.1:${port}/pair`)
      await expect(page.getByText(/Open the pairing link printed/)).toBeVisible()
      await expect(page.getByRole('button', { name: 'Sign in with a passkey' })).toHaveCount(0)

      // Back on the domain: removing needs the password.
      await page.goto(`${origin}/settings/remote-access`)
      await page.getByLabel('Security password', { exact: true }).fill(PASSWORD)
      await page.getByRole('button', { name: 'Remove passkey E2E phone' }).click()
      await expect(page.getByText('Passkey removed.')).toBeVisible()
      await expect(page.getByText('No passkeys yet.')).toBeVisible()
    } finally {
      child.kill('SIGTERM')
      if (child.exitCode === null && child.signalCode === null) await once(child, 'exit')
      rmSync(home, { recursive: true, force: true })
    }
  })
})
