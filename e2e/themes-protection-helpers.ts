import type { Locator, Page } from '@playwright/test'
import { mockThemes, type Look, type MockTheme } from './themes-fixtures.ts'
import { pair } from './pair.ts'
import { startApproval } from './themes-decision.ts'

// Phase 9 gate fixes (decision 101, G1): a theme can't reach inside a protected subtree, and what it can still do from
// outside (fade an ancestor, animate, hover) never leaves a decision unreadable: each attempt below ends with the
// decision visible and readable, either because the theme never got there or because Score fell back to its own look.
// The theme's server routes are mocked per contract § 16.

function gate(css: string, manifest: Record<string, unknown> = {}): MockTheme {
  return { id: 'gate', name: 'Gate', source: 'imported', manifest, css }
}

export async function wear(page: Page, css: string, manifest: Record<string, unknown> = {}) {
  const look: Look = { active: 'gate', mode: 'light' }
  await mockThemes(page, [gate(css, manifest)], look)
  await pair(page)
}

/** The new shell's room with the fixture approval, wearing the gate theme. Resolves with the Needs-you card. */
export async function wearApproval(
  page: Page,
  css: string,
  manifest: Record<string, unknown> = {},
) {
  const found = await startApproval(page, [gate(css, manifest)], { active: 'gate', mode: 'light' })
  return { ...found, url: '/b' }
}

/** Lets the guard's debounce and any delayed animation run. */
export async function settle(page: Page, ms = 1600) {
  await page.waitForTimeout(ms)
}

/**
 * What a person looking at `root` could not read or reach: every element that carries text or is a control must be
 * displayed, visible, opaque, painted in a colour that contrasts with what is behind it, and on top where it is.
 * Colours go through a canvas so any CSS colour syntax is measured.
 */
export async function unreadable(root: Locator): Promise<string[]> {
  return root.evaluate((surface) => {
    const canvas = document.createElement('canvas')
    canvas.width = canvas.height = 1
    const context = canvas.getContext('2d', { willReadFrequently: true })!
    const rgba = (value: string): [number, number, number, number] => {
      context.clearRect(0, 0, 1, 1)
      context.fillStyle = '#000'
      context.fillStyle = value
      context.fillRect(0, 0, 1, 1)
      const d = context.getImageData(0, 0, 1, 1).data
      return [d[0]!, d[1]!, d[2]!, d[3]! / 255]
    }
    const luminance = ([r, g, b]: number[]) => {
      const f = (c: number) => ((c /= 255) <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4)
      return 0.2126 * f(r!) + 0.7152 * f(g!) + 0.0722 * f(b!)
    }
    const problems: string[] = []
    const all = [surface, ...Array.from(surface.querySelectorAll('*'))].filter(
      (el) => !el.closest('svg') || el === surface,
    )
    for (const el of all) {
      const own = Array.from(el.childNodes).some(
        (n) => n.nodeType === 3 && (n.textContent ?? '').trim() !== '',
      )
      const control = el.matches('button, a[href], input, select, textarea')
      if (!own && !control) continue
      // Closed on purpose: the content of a collapsed <details> (outside its summary) is not on screen, whatever the
      // theme does. Chrome gives it no layout box, or none until something forces one, which made this check flaky.
      const collapsed = (() => {
        for (let n: Element | null = el; n; n = n.parentElement) {
          const parent = n.parentElement
          if (parent instanceof HTMLDetailsElement && !parent.open && n.tagName !== 'SUMMARY')
            return true
        }
        return false
      })()
      if (collapsed) continue
      const name = `${el.tagName.toLowerCase()}.${String((el as HTMLElement).className).split(' ')[0]}`
      let opacity = 1
      for (let n: Element | null = el; n; n = n.parentElement) {
        const s = getComputedStyle(n)
        opacity *= Number(s.opacity)
        if (s.display === 'none') problems.push(`${name}: display none (${n.tagName})`)
        if (s.visibility !== 'visible') problems.push(`${name}: ${s.visibility}`)
        if (s.filter !== 'none') problems.push(`${name}: filter`)
        if (s.clipPath !== 'none') problems.push(`${name}: clip`)
      }
      if (opacity < 0.7 && !(el as HTMLButtonElement).disabled)
        problems.push(`${name}: opacity ${opacity}`)
      const box = el.getBoundingClientRect()
      if (box.width === 0 || box.height === 0) problems.push(`${name}: no box`)
      const style = getComputedStyle(el)
      const text = rgba(style.color)
      const fill = rgba(style.webkitTextFillColor)
      if (own && (text[3] < 1 || fill[3] < 1)) problems.push(`${name}: transparent text`)
      // Painted behind: the first opaque background up the chain.
      let back: [number, number, number, number] = [255, 255, 255, 1]
      for (let n: Element | null = el; n; n = n.parentElement) {
        const c = rgba(getComputedStyle(n).backgroundColor)
        if (c[3] > 0) {
          back = c
          if (c[3] >= 1) break
        }
      }
      const a = luminance(text)
      const b = luminance(back)
      const ratio = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05)
      if (own && ratio < 4.5) problems.push(`${name}: contrast ${ratio.toFixed(2)}`)
    }
    return problems
  })
}

/** How each shape of a glyph is painted, as a string: geometry, paint and visibility. */
export async function glyphPaint(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    Array.from(document.querySelectorAll('.agent-glyph')).flatMap((glyph) =>
      Array.from(glyph.querySelectorAll('path, circle, rect, polygon'))
        // The eyes animate (blink, look): their size differs between any two instants; protected.css pins their paint.
        .filter((shape) => !shape.closest('.agent-face'))
        .map((shape) => {
          const s = getComputedStyle(shape)
          const box = (shape as SVGGraphicsElement).getBBox()
          return [
            shape.tagName,
            s.opacity,
            s.visibility,
            s.display,
            s.transform,
            s.fill,
            s.stroke,
            s.strokeWidth,
            s.getPropertyValue('d'),
            s.clipPath,
            s.mask,
            s.filter,
            Math.round(box.width),
            Math.round(box.height),
          ].join('|')
        }),
    ),
  )
}

export const CARD = 'article[aria-label^="Needs you:"]'
export const harmless = '.main { box-shadow: 0 1px 2px rgb(0 0 0 / 12%); }'
