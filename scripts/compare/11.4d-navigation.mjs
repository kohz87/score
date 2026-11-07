import { baseURL, prototype } from './11.4d-config.mjs'

export async function waitForFonts(page) {
  await page.waitForFunction(() => globalThis.document.fonts.status === 'loaded')
}

export async function openPrototypeRoom(page) {
  await page.goto(prototype, { waitUntil: 'domcontentloaded' })
  await page.locator('.top .word').waitFor()
  await waitForFonts(page)
}

export async function openAppRoom(page, path = '/b') {
  await page.goto(`${baseURL}${path}`)
  await page.locator('[data-ui="bold"] .top .word').waitFor({ timeout: 20_000 })
  await waitForFonts(page)
}

export async function prototypeDropdown(page) {
  await page.evaluate(() => globalThis.document.querySelector('[data-a="roomDrop"]')?.click())
  await page.locator('.menu[role="listbox"]').waitFor()
}

export async function appDropdown(page) {
  await page.locator('.roomtitle').click()
  await page.locator('.bold-room-switch').waitFor()
}

export async function prototypeElsewhere(page) {
  await page.evaluate(() => {
    globalThis.document.querySelector('[data-a="roomDrop"]')?.click()
    globalThis.document.querySelector('[data-a="else"][data-v="e1"]')?.click()
  })
  await page.locator('.sidebody .btn.primary').waitFor()
}

export async function appElsewhere(page) {
  await appDropdown(page)
  await page.getByRole('option', { name: /Plan the launch checklist/ }).click()
  await page.locator('.bold-elsewhere').waitFor()
  await page.getByRole('button', { name: 'Preview this chat' }).click()
  await page.getByRole('button', { name: 'Bring into a job' }).waitFor()
}

export async function prototypeJobMenu(page) {
  await page.evaluate(() =>
    globalThis.document.querySelector('[data-a="job"][data-v="feed"]')?.click(),
  )
  await page.evaluate(() => globalThis.document.querySelector('[data-a="jobMenu"]')?.click())
  await page.locator('button[data-a="jobMenu"] + .menu').waitFor()
}

export async function appJobMenu(page) {
  await openAppRoom(page, '/b?job=job-activity')
  await page.getByRole('button', { name: 'Job menu' }).click()
  await page.locator('.bold-job-menu').waitFor()
}

export async function prototypeRoomMenu(page) {
  await page.evaluate(() => globalThis.document.querySelector('[data-a="roomMenu"]')?.click())
  await page.locator('button[data-a="roomMenu"] + .menu').waitFor()
}

export async function appRoomMenu(page) {
  await openAppRoom(page, '/b?room=room-old')
  await page.getByRole('button', { name: 'Room menu' }).click()
  await page.locator('.bold-room-menu').waitFor()
}
