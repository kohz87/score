import { deleteCharBackward, deleteCharForward } from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, describe, expect, test } from 'vitest'
import { livePreview, setLiveFocus, sourceMode } from './live-preview.ts'

const B64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='
const IMG = `![chart](data:image/png;base64,${B64})`

let view: EditorView | null = null
afterEach(() => {
  view?.destroy()
  view = null
  document.body.innerHTML = ''
})
function open(doc: string, source = false, anchor = 0) {
  view?.destroy()
  const parent = document.createElement('div')
  document.body.append(parent)
  view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      selection: { anchor },
      extensions: [
        markdown({ base: markdownLanguage }),
        source
          ? sourceMode()
          : livePreview({ onOpenWikilink: () => undefined, isMissing: () => false }),
      ],
    }),
  })
  return view
}

describe('live editor', () => {
  test('the picture replaces the Markdown, and the base64 is nowhere in the DOM', () => {
    const v = open(`Intro\n\n${IMG}\n\nAfter\n`)
    const img = v.dom.querySelector<HTMLImageElement>('.cm-lp-image img')!
    expect(img.getAttribute('src')).toBe(`data:image/png;base64,${B64}`)
    expect(img.alt).toBe('chart')
    expect(v.dom.textContent).not.toContain(B64.slice(0, 20))
    expect(v.dom.textContent).not.toContain('data:image')
  })

  test('also on the active line: the caret on the image line does not reveal the data', () => {
    const text = `Intro\n\n${IMG}\n\nAfter\n`
    const v = open(text, false, text.indexOf('![chart]'))
    v.dispatch({ selection: { anchor: text.indexOf('![chart]') }, effects: setLiveFocus.of(true) })
    expect(v.dom.querySelector('.cm-lp-image img')).not.toBeNull()
    expect(v.dom.textContent).not.toContain(B64.slice(0, 20))
    // The caret sits in a line that also has text: still hidden.
    const mixed = `before ${IMG} after`
    const w = open(mixed, false, 3)
    w.dispatch({ selection: { anchor: 3 }, effects: setLiveFocus.of(true) })
    expect(w.dom.textContent).toContain('before')
    expect(w.dom.textContent).not.toContain(B64.slice(0, 20))
  })

  test('Backspace and Delete remove the whole image, never part of the data', () => {
    const text = `a ${IMG} b`
    const v = open(text, false, 2 + IMG.length)
    deleteCharBackward(v)
    expect(v.state.doc.toString()).toBe('a  b')
    const w = open(text, false, 2)
    deleteCharForward(w)
    expect(w.state.doc.toString()).toBe('a  b')
  })

  test('the description is editable under the picture and changes only the alt text', () => {
    const v = open(`x\n${IMG}\n`)
    const input = v.dom.querySelector<HTMLInputElement>('.cm-lp-image-alt')!
    expect(input.getAttribute('aria-label')).toBe('Image description (alt text)')
    input.value = 'Q3 [revenue]'
    input.dispatchEvent(new Event('change'))
    expect(v.state.doc.toString()).toBe(`x\n![Q3 revenue](data:image/png;base64,${B64})\n`)
  })

  test('Remove takes the image out', () => {
    const v = open(`x\n${IMG}\ny`)
    v.dom.querySelector<HTMLButtonElement>('.cm-lp-image-remove')!.click()
    expect(v.state.doc.toString()).toBe('x\n\ny')
  })

  test('an image inside a code fence is left as text', () => {
    const v = open('```\n' + IMG + '\n```\n')
    expect(v.dom.querySelector('.cm-lp-image')).toBeNull()
  })

  test('a normal remote image and a non-image data URI are not touched', () => {
    const v = open('![a](https://example.com/a.png)\n\n[x](data:text/plain;base64,QUJD)\n')
    expect(v.dom.querySelector('.cm-lp-image')).toBeNull()
  })
})

describe('Source mode', () => {
  test('the data URI collapses to a chip with type and size; there is no picture', () => {
    const v = open(`${IMG}\n`, true)
    const chip = v.dom.querySelector<HTMLButtonElement>('.cm-lp-image-chip')!
    expect(chip.textContent).toBe('data:image/png · 70 B')
    expect(v.dom.querySelector('.cm-lp-image img')).toBeNull()
    expect(v.dom.textContent).not.toContain(B64.slice(0, 20))
  })

  test('clicking the chip, or moving the caret in, shows the Markdown; leaving collapses it again', () => {
    const v = open(`${IMG}\nnext`, true)
    v.dom.querySelector<HTMLButtonElement>('.cm-lp-image-chip')!.click()
    expect(v.state.selection.main.head).toBeGreaterThan(0)
    expect(v.dom.querySelector('.cm-lp-image-chip')).toBeNull()
    expect(v.dom.textContent).toContain(B64.slice(0, 20))
    v.dispatch({ selection: { anchor: IMG.length + 3 } })
    expect(v.dom.querySelector('.cm-lp-image-chip')).not.toBeNull()
    expect(v.dom.textContent).not.toContain(B64.slice(0, 20))
  })

  test('formatting is off in Source: headings stay plain text', () => {
    const v = open('# Title\n', true)
    expect(v.dom.querySelector('.cm-lp-h1')).toBeNull()
    expect(v.dom.classList).toContain('cm-source')
  })
})
