import { prototype } from './bold-frame-paths.mjs'
import { parts } from './bold-frame-parts-frame.mjs'

export async function measure(page, selectedParts = parts, side = 'prototype') {
  return page.evaluate(
    ({ selectedParts, side }) => {
      const result = {}
      for (const part of selectedParts) {
        // Parts name their selectors either as `selectors: { prototype, app }` (11.10d) or `appSelector` (11.9b).
        const selector =
          part.selectors?.[side] ??
          (side === 'app' ? (part.appSelector ?? part.selector) : part.selector)
        const element = globalThis.document.querySelector(selector)
        if (!element) {
          result[part.name] = null
          continue
        }
        const style = globalThis.getComputedStyle(element)
        result[part.name] = Object.fromEntries(
          [...part.props, 'display'].map((property) => [property, style[property]]),
        )
      }
      return result
    },
    { selectedParts, side },
  )
}

export function cell(metrics, part) {
  const value = metrics[part.name]
  if (!value) return 'not rendered'
  if (value.display === 'none') return 'hidden'
  return part.props.map((property) => `${property} ${value[property]}`).join(' · ')
}

export function difference(prototypeMetrics, appMetrics, part) {
  const left = prototypeMetrics[part.name]
  const right = appMetrics[part.name]
  if (!left || !right)
    return left?.display === 'none' || right?.display === 'none'
      ? 'hidden in both'
      : 'missing on one side'
  const differing = part.props.filter((property) => left[property] !== right[property])
  return differing.length === 0 ? 'same' : differing.join(', ')
}

export async function openPrototypeSettings(page, section) {
  await page.goto(prototype, { waitUntil: 'domcontentloaded' })
  await page.locator('.top .word').waitFor()
  await page.locator('[data-a="go"][data-v="settings"]:visible').click()
  await page.locator(`[data-a="setSec"][data-v="${section}"]`).click()
  await page.locator('.setgrid .setnav').waitFor()
  await page.evaluate(() => globalThis.document.fonts.ready)
}
