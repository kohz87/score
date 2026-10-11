import { syntaxTree } from '@codemirror/language'
import { StateField, type EditorState, type Extension, type Range } from '@codemirror/state'
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view'
import { chipLabel, escapeAlt, EMBEDDED_IMAGE } from './knowledge-images.ts'

/**
 * Embedded images (PLAN 6.8): `![alt](data:image/...;base64,...)` is replaced as a whole, so the base64 never shows.
 *
 * - `widget` (live editor): the picture itself, on every line, the caret's line included. Alt text can be edited under
 *   it and the image removed with its button.
 * - `chip` (Source mode): a short chip, `data:image/png · 240 KB`. A click, or the caret entering the image, shows the
 *   raw Markdown; it collapses again when the caret leaves.
 *
 * The replaced range is atomic: arrow keys jump over it and Backspace/Delete remove the whole image, never one
 * character of the data.
 */

export type ImageMode = 'widget' | 'chip'

const CODE_NODES = new Set(['FencedCode', 'CodeBlock', 'InlineCode'])

function inCode(state: EditorState, pos: number): boolean {
  const node = syntaxTree(state).resolveInner(pos, 1)
  for (let parent: typeof node | null = node; parent; parent = parent.parent) {
    if (CODE_NODES.has(parent.name)) return true
  }
  return false
}

class ImageWidget extends WidgetType {
  constructor(
    private readonly alt: string,
    private readonly uri: string,
  ) {
    super()
  }
  override eq(other: ImageWidget) {
    return other.alt === this.alt && other.uri === this.uri
  }
  private get length() {
    return `![${this.alt}](${this.uri})`.length
  }
  override toDOM(view: EditorView) {
    const wrap = document.createElement('span')
    wrap.className = 'cm-lp-image'
    const img = document.createElement('img')
    img.src = this.uri
    img.alt = this.alt
    img.draggable = false
    // The line grows once the picture has loaded; tell CodeMirror to measure again.
    img.addEventListener('load', () => view.requestMeasure())
    wrap.append(img)
    if (view.state.readOnly) return wrap

    const caption = document.createElement('span')
    caption.className = 'cm-lp-image-bar'
    const input = document.createElement('input')
    input.type = 'text'
    input.className = 'cm-lp-image-alt'
    input.value = this.alt
    input.placeholder = 'Describe this image'
    input.setAttribute('aria-label', 'Image description (alt text)')
    input.maxLength = 300
    const commit = () => {
      const next = escapeAlt(input.value)
      if (next === this.alt) return
      const from = view.posAtDOM(wrap)
      if (view.state.sliceDoc(from, from + 2 + this.alt.length + 2) !== `![${this.alt}](`) return
      view.dispatch({ changes: { from: from + 2, to: from + 2 + this.alt.length, insert: next } })
    }
    input.addEventListener('change', commit)
    input.addEventListener('keydown', (event) => {
      if (event.key === 'Enter') {
        event.preventDefault()
        commit()
        view.focus()
      } else if (event.key === 'Escape') {
        input.value = this.alt
        view.focus()
      }
    })
    const remove = document.createElement('button')
    remove.type = 'button'
    remove.className = 'cm-lp-image-remove'
    remove.textContent = 'Remove'
    remove.setAttribute('aria-label', `Remove image${this.alt ? ` ${this.alt}` : ''}`)
    remove.addEventListener('mousedown', (event) => event.preventDefault())
    remove.addEventListener('click', () => {
      const from = view.posAtDOM(wrap)
      view.dispatch({ changes: { from, to: from + this.length } })
      view.focus()
    })
    caption.append(input, remove)
    wrap.append(caption)
    return wrap
  }
  // Typing in the description and clicking Remove are the widget's own; clicks on the picture go to the editor.
  override ignoreEvent(event: Event) {
    const target = event.target
    return target instanceof HTMLInputElement || target instanceof HTMLButtonElement
  }
}

class ChipWidget extends WidgetType {
  constructor(private readonly label: string) {
    super()
  }
  override eq(other: ChipWidget) {
    return other.label === this.label
  }
  override toDOM(view: EditorView) {
    const chip = document.createElement('button')
    chip.type = 'button'
    chip.className = 'cm-lp-image-chip'
    chip.textContent = this.label
    chip.setAttribute('aria-label', `Embedded image, ${this.label}. Show the Markdown`)
    chip.addEventListener('mousedown', (event) => event.preventDefault())
    chip.addEventListener('click', () => {
      view.dispatch({ selection: { anchor: view.posAtDOM(chip) + 2 } })
      view.focus()
    })
    return chip
  }
  override ignoreEvent() {
    return true
  }
}

function scan(state: EditorState, mode: ImageMode): DecorationSet {
  const { doc } = state
  const out: Range<Decoration>[] = []
  const selection = state.selection.ranges
  for (let n = 1; n <= doc.lines; n += 1) {
    const line = doc.line(n)
    // Cheap test first: most lines are short and have no data URI.
    if (line.length < 40 || !line.text.includes('](data:image/')) continue
    EMBEDDED_IMAGE.lastIndex = 0
    for (const found of line.text.matchAll(EMBEDDED_IMAGE)) {
      const from = line.from + found.index
      const to = from + found[0].length
      if (inCode(state, from)) continue
      if (mode === 'chip' && selection.some((range) => range.to > from && range.from < to)) continue
      out.push(
        Decoration.replace({
          widget:
            mode === 'widget'
              ? new ImageWidget(found[1]!, found[2]!)
              : new ChipWidget(chipLabel(found[2]!)),
        }).range(from, to),
      )
    }
  }
  return Decoration.set(out, true)
}

export function imageExtension(mode: ImageMode): Extension {
  const field = StateField.define<DecorationSet>({
    create: (state) => scan(state, mode),
    update(value, tr) {
      if (tr.docChanged || (mode === 'chip' && tr.selection)) return scan(tr.state, mode)
      return value
    },
    provide: (f) => [
      EditorView.decorations.from(f),
      EditorView.atomicRanges.of((view) => view.state.field(f)),
    ],
  })
  return field
}
