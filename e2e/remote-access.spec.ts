import { execFileSync, spawn } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
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
  const child = spawn(process.execPath, ['--import', loader, entry], {
    env: {
      ...process.env,
      SCORE_HOME: home,
      SCORE_MODE: 'fake',
      SCORE_HOST: '127.0.0.1',
      SCORE_PORT: String(port),
      SCORE_REMOTE: '1',
      SCORE_TLS_CERT: join(home, 'tls', 'server.crt'),
      SCORE_TLS_KEY: join(home, 'tls', 'server.key'),
      SCORE_PUBLIC_ORIGINS: origin,
      SCORE_BRIDGE_PORT: String(port + 1),
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
    await expect(page.getByRole('heading', { level: 1 })).toBeVisible()
    await page.getByRole('link', { name: 'Settings', exact: true }).click()
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
