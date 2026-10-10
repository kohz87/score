import { execFileSync, spawn } from 'node:child_process'
import { once } from 'node:events'
import { createHash, randomBytes, scryptSync } from 'node:crypto'
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'

// The web terminal needs HTTPS and a security password set on the host, so this spec starts its own remote-mode Score
// (fake adapter, test certificate from `scripts/score tls` in a temp home) with SCORE_TERMINAL=1.
test.beforeAll(() => {
  const dist = fileURLToPath(new URL('../apps/web/dist/index.html', import.meta.url))
  if (!existsSync(dist))
    execFileSync('pnpm', ['--filter', '@score/web', 'build'], { stdio: 'ignore', timeout: 120_000 })
})
test.use({ ignoreHTTPSErrors: true })

const launcher = fileURLToPath(new URL('../scripts/score', import.meta.url))
const loader = fileURLToPath(
  new URL('../apps/server/node_modules/tsx/dist/loader.mjs', import.meta.url),
)
const entry = fileURLToPath(new URL('../apps/server/src/index.ts', import.meta.url))
const PASSWORD = 'correct horse battery'

/** What `scripts/score password` writes on the host: the hash, and the mark that says the host issued it. */
function hostPassword(home: string) {
  const salt = randomBytes(16)
  const key = scryptSync(PASSWORD, salt, 32, { N: 2 ** 15, r: 8, p: 1, maxmem: 64 * 1024 * 1024 })
  const line = `scrypt$15$8$1$${salt.toString('base64url')}$${key.toString('base64url')}`
  writeFileSync(join(home, 'security-password'), `${line}\n`, { mode: 0o600 })
  writeFileSync(
    join(home, 'security-password.origin'),
    `host ${createHash('sha256').update(line).digest('hex')}\n`,
    { mode: 0o600 },
  )
}

test('open a terminal over HTTPS, run echo, see the output, close it from Settings', async ({
  page,
}) => {
  const home = mkdtempSync(join(tmpdir(), 'score-terminal-e2e-'))
  const port = Number(process.env.SCORE_PORT ?? 8740) + 6
  const origin = `https://127.0.0.1:${port}`
  execFileSync(launcher, ['tls'], {
    env: { PATH: process.env.PATH!, HOME: home, SCORE_HOME: home, SCORE_HOST: '127.0.0.1' },
    stdio: 'ignore',
  })
  hostPassword(home)
  const child = spawn(process.execPath, ['--import', loader, entry], {
    env: {
      ...process.env,
      SCORE_HOME: home,
      HOME: home,
      SCORE_MODE: 'fake',
      SCORE_HOST: '127.0.0.1',
      SCORE_PORT: String(port),
      SCORE_REMOTE: '1',
      SCORE_TERMINAL: '1',
      SCORE_TLS_CERT: join(home, 'tls', 'server.crt'),
      SCORE_TLS_KEY: join(home, 'tls', 'server.key'),
      SCORE_PUBLIC_ORIGINS: origin,
      SCORE_BRIDGE_PORT: String(port + 1),
      SCORE_PRINT_PAIR_LINK: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let output = ''
  child.stdout.on('data', (chunk: Buffer) => (output += chunk.toString()))
  child.stderr.on('data', (chunk: Buffer) => (output += chunk.toString()))
  try {
    await expect.poll(() => /\/pair#([\w-]+)/.exec(output)?.[1], { timeout: 60_000 }).toBeTruthy()
    const token = /\/pair#([\w-]+)/.exec(output)![1]!
    await page.goto(`${origin}/pair#${token}`)
    await page.getByRole('button', { name: 'Pair this browser' }).click()
    await expect(page.getByText('This browser is paired')).toBeVisible()

    await page.goto(`${origin}/terminal`)
    await expect(page.getByText(/This is a shell on the Score machine/)).toBeVisible()
    // A wrong password opens nothing.
    await page.getByLabel('Security password').fill('not the password')
    await page.getByRole('button', { name: 'Open terminal' }).click()
    await expect(page.getByRole('alert')).toHaveText('That is not the security password.')

    await page.getByLabel('Security password').fill(PASSWORD)
    await page.getByRole('button', { name: 'Open terminal' }).click()
    const screen = page.getByTestId('terminal-screen')
    await expect(screen).toBeVisible()
    await expect(page.getByText(/as \w+\./)).toBeVisible({ timeout: 15_000 })
    await page.locator('.xterm-helper-textarea').focus()
    await page.keyboard.type('echo score-$((40+2))-ok')
    await page.keyboard.press('Enter')
    await expect(screen).toContainText('score-42-ok', { timeout: 15_000 })

    // Settings lists the open terminal; Close ends it.
    const settings = await page.context().newPage()
    await settings.goto(`${origin}/settings`)
    await expect(settings.getByRole('heading', { name: 'Terminal' })).toBeVisible()
    await settings
      .getByRole('list', { name: 'Open terminals' })
      .getByRole('button', { name: 'Close' })
      .click()
    await expect(page.getByText('Closed.')).toBeVisible({ timeout: 15_000 })
    await settings.close()
  } finally {
    child.kill('SIGTERM')
    if (child.exitCode === null && child.signalCode === null) await once(child, 'exit')
    rmSync(home, { recursive: true, force: true })
  }
})
