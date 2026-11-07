import { baseURL, prototype } from './11.6b-config.mjs'

export async function prototypeBench(page, bench) {
  await page.goto(prototype, { waitUntil: 'domcontentloaded' })
  await page.locator('.top .word').waitFor()
  await page.evaluate((next) => {
    globalThis.document.querySelector(`[data-a="bench"][data-v="${next}"]`)?.click()
  }, bench)
  await page.locator(bench === 'code' ? '.code' : '.term').waitFor()
  await page.evaluate(() => globalThis.document.fonts.ready)
}

export async function openPrototypeReplay(page) {
  await prototypeBench(page, 'screen')
  await page.evaluate(() => {
    globalThis.document.querySelector('[data-a="go"][data-v="replay"]')?.click()
  })
  await page.locator('.page .step').first().waitFor()
  await page.evaluate(() => globalThis.document.fonts.ready)
}

export async function appWorkbench(page, work) {
  await page.goto(`${baseURL}/b?job=job-feed&work=${work}`)
  await page.locator('[data-ui="bold"] .top .word').waitFor({ timeout: 20_000 })
  if (await page.getByRole('button', { name: 'Open side panel' }).count())
    await page.getByRole('button', { name: 'Open side panel' }).click()
  await page.getByTestId('bold-workbench').waitFor({ timeout: 20_000 })
  await page.waitForFunction(() => globalThis.document.fonts.status === 'loaded')
}

export async function appScreen(page) {
  await page.goto(`${baseURL}/b/screen/builder`)
  await page.getByRole('heading', { name: 'builder’s screen' }).waitFor({ timeout: 20_000 })
  await page.locator('.bold-screen-step').first().waitFor({ timeout: 20_000 })
  await page.waitForFunction(() => globalThis.document.fonts.status === 'loaded')
}
