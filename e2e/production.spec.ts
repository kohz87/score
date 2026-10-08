import { execFileSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { expect, test } from '@playwright/test'

const launcher = fileURLToPath(new URL('../scripts/score', import.meta.url))

// Smoke test of the built app: `pnpm build` output, started through the launcher, one loopback port.
test.beforeAll(() => {
  const dist = fileURLToPath(new URL('../apps/web/dist/index.html', import.meta.url))
  if (!existsSync(dist))
    execFileSync('pnpm', ['--filter', '@score/web', 'build'], { stdio: 'ignore', timeout: 120_000 })
})

test('built app: launcher starts it, a browser pairs and sees the shell, stop frees the port', async ({
  page,
  request,
}) => {
  const home = mkdtempSync(join(tmpdir(), 'score-prod-e2e-'))
  const port = Number(process.env.SCORE_PORT ?? 8740) + 5
  const origin = `http://127.0.0.1:${port}`
  const env = { ...process.env, SCORE_HOME: home, SCORE_PORT: String(port), SCORE_MODE: 'fake' }
  const run = (command: string) =>
    execFileSync(launcher, [command], { env, encoding: 'utf8', timeout: 60_000 })
  try {
    const started = run('start')
    expect(run('status')).toContain(`${origin}`)
    expect(run('start')).toContain('already running')
    expect(started).toContain(`${origin}/pair#`)
    expect((await request.get(`${origin}/api/health`)).ok()).toBe(true)

    const link = /Pair this browser: (\S+)/.exec(run('pair'))![1]!
    expect(link).not.toBe(/Pair this browser: (\S+)/.exec(started)![1])
    await page.goto(link)
    await expect(page.getByText('This browser is paired')).toBeVisible()
    await page.goto(`${origin}/now`)
    await expect(page.getByRole('heading', { name: 'Now', exact: true })).toBeVisible()
    // Deep links fall back to the app shell.
    await page.reload()
    await expect(page.getByRole('heading', { name: 'Now', exact: true })).toBeVisible()
    expect((await request.get(`${origin}/api/nope`)).status()).toBe(404)
  } finally {
    run('stop')
    rmSync(home, { recursive: true, force: true })
  }
  await expect(request.get(`${origin}/api/health`)).rejects.toThrow()
})
