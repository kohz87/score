/* global document */
import { baseURL } from './11.10a-config.mjs'
import { board } from './11.10a-fixtures.mjs'

async function waitForFonts(page) {
  await page.waitForFunction(() => document.fonts.status === 'loaded')
}

export async function openBoard(page, number) {
  await page.goto(board(number), { waitUntil: 'domcontentloaded' })
  await page.locator('body').waitFor()
  await waitForFonts(page)
}

export async function openApp(page, path) {
  await page.goto(`${baseURL}${path}`)
  await page.locator('[data-ui="bold"] .top .word').waitFor({ timeout: 20_000 })
  await waitForFonts(page)
}
