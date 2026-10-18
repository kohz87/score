import { afterEach, beforeEach, expect, test, vi } from 'vitest'

// Re-gate finding #6: a decision is vetted as a whole. jsdom has no layout, so a "theme" is simulated: elements marked
// data-themed-hide have no box while it is on, and the guard's lifting of the theme (appliedThemeElements) turns it off.
const theme = vi.hoisted(() => ({ on: true }))
vi.mock('./engine.ts', () => ({
  appliedThemeSheets: () => [],
  appliedThemeElements: () => [
    {
      get disabled() {
        return !theme.on
      },
      set disabled(value: boolean) {
        theme.on = !value
      },
    },
  ],
}))

const { decisionProblem } = await import('./guard.ts')

const rect = {
  x: 0,
  y: 0,
  width: 10,
  height: 10,
  top: 0,
  left: 0,
  right: 10,
  bottom: 10,
} as DOMRect
let rects: typeof Element.prototype.getClientRects

beforeEach(() => {
  theme.on = true
  // jsdom has no hit testing; every simulated box sits at the same spot, so nothing counts as painted there with or
  // without the theme (the guard compares the two, so this alone never refuses).
  document.elementFromPoint = () => null
  // jsdom has no constructable sheets.
  Object.defineProperty(document, 'adoptedStyleSheets', {
    value: [],
    writable: true,
    configurable: true,
  })
  document.documentElement.setAttribute('data-look', 'custom')
  rects = Element.prototype.getClientRects
  Element.prototype.getClientRects = function (this: Element) {
    const hidden = theme.on && this.closest('[data-themed-hide]') !== null
    return (hidden ? [] : [rect]) as unknown as DOMRectList
  }
})
afterEach(() => {
  Element.prototype.getClientRects = rects
  document.documentElement.removeAttribute('data-look')
  document.body.innerHTML = ''
})

test('without a decision boundary the nearest surface is all that is vetted (the old behaviour)', () => {
  document.body.innerHTML = `
    <section>
      <div data-protected="flex" data-themed-hide><p>May I install it?</p></div>
      <div data-protected="flex"><button id="go">Approve</button></div>
    </section>`
  expect(decisionProblem(document.getElementById('go')!)).toBeNull()
})

test('inside a data-decision, the request text hidden by the theme refuses the button next to it', () => {
  document.body.innerHTML = `
    <section data-decision>
      <div data-protected="flex" data-themed-hide><p>May I install it?</p></div>
      <div data-protected="flex"><button id="go">Approve</button></div>
    </section>`
  expect(decisionProblem(document.getElementById('go')!)).toMatch(/is not shown/)
})

test('a form is a decision: its submit event is vetted against the committing button and the context', () => {
  document.body.innerHTML = `
    <form data-decision id="form">
      <p data-protected="block">Full access turns the sandbox off.</p>
      <input aria-label="Name" />
      <div data-themed-hide><button data-protected="inline-flex">Add coding agent</button></div>
    </form>`
  expect(decisionProblem(document.getElementById('form')!)).toMatch(/is not shown/)
})

test('a clean decision goes through, and a theme-free page is never vetted', () => {
  document.body.innerHTML = `
    <section data-decision>
      <div data-protected="flex"><p>May I install it?</p></div>
      <div data-protected="flex"><button id="go">Approve</button></div>
    </section>`
  expect(decisionProblem(document.getElementById('go')!)).toBeNull()
  document.body.innerHTML = `
    <section data-decision><div data-protected data-themed-hide><button id="x">Go</button></div></section>`
  document.documentElement.removeAttribute('data-look')
  expect(decisionProblem(document.getElementById('x')!)).toBeNull()
})

// Third gate, finding 1: the fields of a form are part of the decision whether or not each one is marked protected.
test('an unmarked field or label of the decision, hidden by the theme, refuses the commit button', () => {
  document.body.innerHTML = `
    <form data-decision id="form">
      <label data-themed-hide>Agent name <input id="name" /></label>
      <p data-protected="block">Full access turns the sandbox off.</p>
      <div data-protected="flex"><button id="go">Add coding agent</button></div>
    </form>`
  expect(decisionProblem(document.getElementById('go')!)).toMatch(/is not shown/)
  expect(decisionProblem(document.getElementById('form')!)).toMatch(/is not shown/)
})

test('the same fields shown by the theme, or hidden by Score’s own look too, do not refuse', () => {
  document.body.innerHTML = `
    <form data-decision id="form">
      <label>Role <input /></label>
      <div data-protected="flex"><button id="go">Add coding agent</button></div>
    </form>`
  expect(decisionProblem(document.getElementById('go')!)).toBeNull()
})
