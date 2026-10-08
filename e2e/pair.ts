import { expect, type Page } from '@playwright/test'
import { closeSync, existsSync, openSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

// The dev server prints one single-use pairing link, but specs run in parallel workers. The first
// caller pairs and saves the session cookie; the others wait for it and reuse it.
export async function pair(page: Page) {
  const home = process.env.SCORE_E2E_HOME!
  const state = join(home, 'paired-session.json')
  let owner = false
  try {
    closeSync(openSync(join(home, 'paired.lock'), 'wx'))
    owner = true
  } catch {
    // Another worker is pairing.
  }
  if (owner) {
    try {
      // Under load the server can be listening before its pairing line reaches dev.log: wait for it.
      let token: string | undefined
      await expect
        .poll(
          () => {
            const log = existsSync(join(home, 'dev.log'))
              ? readFileSync(join(home, 'dev.log'), 'utf8')
              : ''
            token = /\/pair#([\w-]+)/.exec(log)?.[1]
            return token
          },
          { timeout: 30_000 },
        )
        .toBeTruthy()
      await page.goto(`/pair#${token}`)
      await expect(page.getByText('This browser is paired')).toBeVisible({ timeout: 15_000 })
      writeFileSync(state, JSON.stringify(await page.context().cookies()))
    } catch (error) {
      // Let another worker try instead of leaving every spec waiting on a session that never comes.
      rmSync(join(home, 'paired.lock'), { force: true })
      throw error
    }
    return
  }
  await expect.poll(() => existsSync(state), { timeout: 30_000 }).toBe(true)
  await page.context().addCookies(JSON.parse(readFileSync(state, 'utf8')))
  await page.goto('/')
}
