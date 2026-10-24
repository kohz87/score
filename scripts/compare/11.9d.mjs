/* global document, getComputedStyle */
// Side-by-side check for PLAN 11.9d (not part of `pnpm e2e`): with Score's own look the shell's tokens must equal the
// binding prototype's (dark and light sets), at both review sizes. Then it prints what each built-in theme paints for the
// shell's ground, panel and ink. Needs a running paired fake Score: SCORE_COMPARE_URL=http://127.0.0.1:5230 and the
// session cookie file SCORE_COMPARE_STATE (an e2e paired-session.json); `pnpm build` first.
import { join, resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { chromium } from '@playwright/test'

const root = resolve(new URL('../..', import.meta.url).pathname)
const base = process.env.SCORE_COMPARE_URL ?? 'http://127.0.0.1:5230'
const state = process.env.SCORE_COMPARE_STATE
const prototype = pathToFileURL(join(root, 'docs/design/bold/prototype.html')).href
const tokens = [
  'bg',
  'panel',
  'deep',
  'field',
  'line',
  'ink',
  'ink2',
  'muted',
  'faint',
  'hi-bg',
  'hi-ink',
  'hi-sub',
]
const sizes = [
  { width: 1440, height: 900 },
  { width: 390, height: 844 },
]

const browser = await chromium.launch()
let differences = 0
try {
  for (const size of sizes) {
    for (const mode of ['dark', 'light']) {
      const proto = await browser.newPage({ viewport: size })
      await proto.goto(prototype)
      const wanted = await proto.evaluate(
        ([names, light]) => {
          if (light) document.body.setAttribute('data-look', 'light')
          const style = getComputedStyle(document.body)
          return Object.fromEntries(
            names.map((n) => [n, style.getPropertyValue(`--${n}`).trim().toLowerCase()]),
          )
        },
        [tokens, mode === 'light'],
      )
      await proto.close()
      const context = await browser.newContext({
        viewport: size,
        storageState: state,
        colorScheme: mode,
      })
      const page = await context.newPage()
      await page.addInitScript((m) => localStorage.setItem('score.theme', m), mode)
      await page.goto(`${base}/b/team`)
      await page.locator('[data-ui="bold"]').waitFor()
      const got = await page.evaluate((names) => {
        const style = getComputedStyle(document.querySelector('[data-ui="bold"]'))
        return Object.fromEntries(
          names.map((n) => [n, style.getPropertyValue(`--${n}`).trim().toLowerCase()]),
        )
      }, tokens)
      for (const name of tokens)
        if (wanted[name] && wanted[name] !== got[name]) {
          differences += 1
          console.log(`${size.width} ${mode} --${name}: prototype ${wanted[name]} app ${got[name]}`)
        }
      await context.close()
    }
  }
} finally {
  await browser.close()
}
console.log(
  differences === 0 ? 'Score look: tokens match the prototype.' : `${differences} differences.`,
)
