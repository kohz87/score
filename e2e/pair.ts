import { expect, type Page } from '@playwright/test'
import { closeSync, existsSync, openSync, readFileSync, writeFileSync } from 'node:fs'
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
    const log = readFileSync(join(home, 'dev.log'), 'utf8')
    const token = /\/pair#([\w-]+)/.exec(log)?.[1]
    expect(token).toBeTruthy()
    await page.goto(`/pair#${token}`)
    await expect(page.getByText('This browser is paired')).toBeVisible()
    writeFileSync(state, JSON.stringify(await page.context().cookies()))
    return
  }
  await expect.poll(() => existsSync(state), { timeout: 30_000 }).toBe(true)
  await page.context().addCookies(JSON.parse(readFileSync(state, 'utf8')))
  await page.goto('/')
}
