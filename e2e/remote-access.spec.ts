import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { once } from 'node:events'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'

// Remote mode serves the built web app; build it when a fresh checkout doesn't have one yet.
test.beforeAll(() => {
  const dist = fileURLToPath(new URL('../apps/web/dist/index.html', import.meta.url))
  if (!existsSync(dist))
    execFileSync('pnpm', ['--filter', '@score/web', 'build'], { stdio: 'ignore', timeout: 120_000 })
})

// The browser trusts nothing here: the test certificate is made by `scripts/score tls` in a temp home.
test.use({ ignoreHTTPSErrors: true })

const launcher = fileURLToPath(new URL('../scripts/score', import.meta.url))
const loader = fileURLToPath(
  new URL('../apps/server/node_modules/tsx/dist/loader.mjs', import.meta.url),
)
const entry = fileURLToPath(new URL('../apps/server/src/index.ts', import.meta.url))

test('plain HTTP without a certificate shows the HTTPS setup guide and nothing else', async ({
  page,
  request,
}) => {
  const home = mkdtempSync(join(tmpdir(), 'score-guide-e2e-'))
  const port = Number(process.env.SCORE_PORT ?? 8740) + 4
  const child = spawn(process.execPath, ['--import', loader, entry], {
    env: {
      ...process.env,
      SCORE_HOME: home,
      SCORE_MODE: 'fake',
      SCORE_HOST: '127.0.0.1',
      SCORE_PORT: String(port),
      SCORE_REMOTE: '1',
      SCORE_REMOTE_INSECURE_HTTP: 'accept',
      SCORE_PUBLIC_ORIGINS: `https://127.0.0.1:${port}`,
      SCORE_BRIDGE_PORT: String(port + 1),
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()))
  child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()))
  try {
    await expect.poll(() => output, { timeout: 30_000 }).toContain('Setup guide:')
    const origin = `http://127.0.0.1:${port}`
    await page.goto(`${origin}/`)
    await expect(page).toHaveURL(`${origin}/setup/https`)
    await expect(
      page.getByRole('heading', { name: 'Score needs a secure (HTTPS) connection' }),
    ).toBeVisible()
    await expect(page.getByRole('link', { name: 'Open the secure address' })).toHaveAttribute(
      'href',
      `https://127.0.0.1:${port}/`,
    )
    await expect(page.getByText('scripts/score tls').first()).toBeVisible()
    const api = await request.get(`${origin}/api/agents`)
    expect(api.status()).toBe(426)
    expect((await api.json()).error.code).toBe('https_required')
  } finally {
    child.kill('SIGTERM')
    if (child.exitCode === null && child.signalCode === null) await once(child, 'exit')
    rmSync(home, { recursive: true, force: true })
  }
})

test('remote pairing over HTTPS requires consent, protects reads, serves the guide on plain HTTP, and logs out', async ({
  page,
  request,
}) => {
  const home = mkdtempSync(join(tmpdir(), 'score-remote-e2e-'))
  const port = Number(process.env.SCORE_PORT ?? 8740) + 2
  const origin = `https://127.0.0.1:${port}`
  execFileSync(launcher, ['tls'], {
    env: { PATH: process.env.PATH!, HOME: home, SCORE_HOME: home, SCORE_HOST: '127.0.0.1' },
    stdio: 'ignore',
  })
  const logFile = join(home, 'score.log')
  writeFileSync(
    logFile,
    [
      JSON.stringify({ level: 30, time: Date.now() - 2000, msg: 'e2e started cleanly' }),
      JSON.stringify({
        level: 50,
        time: Date.now() - 1000,
        msg: 'e2e failure Authorization: Bearer topsecrettokenvalue1234',
      }),
    ].join('\n') + '\n',
  )
  const child = spawn(process.execPath, ['--import', loader, entry], {
    env: {
      ...process.env,
      SCORE_LOG_FILE: logFile,
      SCORE_HOME: home,
      SCORE_MODE: 'fake',
      SCORE_HOST: '127.0.0.1',
      SCORE_PORT: String(port),
      SCORE_REMOTE: '1',
      SCORE_TLS_CERT: join(home, 'tls', 'server.crt'),
      SCORE_TLS_KEY: join(home, 'tls', 'server.key'),
      SCORE_PUBLIC_ORIGINS: origin,
      SCORE_BRIDGE_PORT: String(port + 1),
      SCORE_PRINT_PAIR_LINK: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString()
  })
  child.stderr.on('data', (chunk: Buffer) => {
    output += chunk.toString()
  })
  try {
    await expect.poll(() => /\/pair#([\w-]+)/.exec(output)?.[1], { timeout: 30_000 }).toBeTruthy()
    const token = /\/pair#([\w-]+)/.exec(output)![1]!
    // The same port answers plain HTTP with the guide, never the app.
    const plain = await request.get(`http://127.0.0.1:${port}/api/agents`)
    expect(plain.status()).toBe(426)
    expect((await request.get(`${origin}/setup/https/score-ca.crt`)).status()).toBe(200)
    expect((await request.get(`${origin}/api/agents`)).status()).toBe(401)
    let redeemed = 0
    page.on('request', (request) => {
      if (request.method() === 'POST' && request.url().endsWith('/api/session/pair')) redeemed++
    })
    await page.goto(`${origin}/pair#${token}`)
    await expect(page.getByRole('button', { name: 'Pair this browser' })).toBeVisible()
    expect(new URL(page.url()).hash).toBe('')
    expect(redeemed).toBe(0)
    await expect(page.getByLabel('Transport warning')).toHaveCount(0)
    await page.getByRole('button', { name: 'Pair this browser' }).click()
    await expect(page.getByText('This browser is paired')).toBeVisible()
    expect(redeemed).toBe(1)
    await page.getByRole('link', { name: 'Open Score' }).click()
    await expect(page.getByRole('banner')).toBeVisible()
    // The remote-access controls live in Settings › Remote access and security.
    await page.goto(`${origin}/b/settings`)
    const sections = page.getByRole('navigation', { name: 'Settings', exact: true })
    await sections.getByRole('button', { name: /^Remote access and security/ }).click()
    await expect(page).toHaveURL(`${origin}/b/settings/security`)
    // Set the security password (that opens the section), then the one-time link comes with a QR code.
    const setPassword = page.getByRole('form', { name: 'Set a security password' })
    await setPassword
      .getByLabel('New password (at least 8 characters)')
      .fill('correct horse battery')
    await setPassword.getByLabel('The same password again').fill('correct horse battery')
    await setPassword.getByRole('button', { name: 'Set password and open' }).click()
    await expect(page.getByText(/Unlocked · locks in/)).toBeVisible()
    await page.getByRole('button', { name: 'Get a pairing link' }).click()
    await expect(page.getByRole('img', { name: 'QR code for the pairing link' })).toBeVisible()
    await expect(page.getByRole('group', { name: 'Pairing link' })).toContainText('/pair#')
    // Settings › System › Logs: parsed lines, filters, and secrets already removed on the server.
    await sections.getByRole('button', { name: /^System/ }).click()
    const logs = page.getByRole('region', { name: 'Logs' })
    await expect(logs.getByText('e2e started cleanly')).toBeVisible()
    await expect(logs.getByText(/e2e failure/)).toBeVisible()
    await expect(logs).not.toContainText('topsecrettokenvalue1234')
    await logs.getByLabel('Level').selectOption('error')
    await expect(logs.getByText('e2e started cleanly')).toHaveCount(0)
    await logs.getByLabel('Level').selectOption('all')
    await logs.getByLabel('Search').fill('cleanly')
    await expect(logs.getByText(/e2e failure/)).toHaveCount(0)
    await sections.getByRole('button', { name: /^Remote access and security/ }).click()
    // Leaving the section locked it again: the password opens it for the log-out button.
    await expect(page.getByRole('region', { name: 'This section is locked' })).toBeVisible()
    await page.getByLabel('Security password', { exact: true }).fill('correct horse battery')
    await page.getByRole('button', { name: 'Unlock' }).click()
    await page.getByRole('button', { name: 'Log out this browser' }).click()
    await expect(page).toHaveURL(`${origin}/pair`)
    await expect(page.getByText(/Open the pairing link printed/)).toBeVisible()
    expect(await page.evaluate(async () => (await fetch('/api/agents')).status)).toBe(401)
  } finally {
    child.kill('SIGTERM')
    if (child.exitCode === null && child.signalCode === null) await once(child, 'exit')
    rmSync(home, { recursive: true, force: true })
  }
})
