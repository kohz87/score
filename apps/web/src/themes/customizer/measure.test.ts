// @vitest-environment jsdom
import { expect, test } from 'vitest'
import { measureText } from './measure.ts'

// jsdom has no layout: give every element a box so the text is considered at all.
function page(html: string): Document {
  document.body.innerHTML = html
  for (const element of document.querySelectorAll('*'))
    element.getBoundingClientRect = () => new DOMRect(10, 10, 100, 20)
  return document
}

test('faint text is found, and the same text in a disabled control is not (it is exempt)', () => {
  const faint = 'color:#ccc;background:#fff'
  const found = measureText(page(`<p style="${faint}">Hello</p>`), null)
  expect(found.map((item) => item.text)).toEqual(['Hello'])
  const disabled = measureText(
    page(`<button disabled style="${faint}"><span>Save</span></button>`),
    null,
  )
  expect(disabled).toEqual([])
})
