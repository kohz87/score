import { HighlightStyle, ensureSyntaxTree, syntaxHighlighting } from '@codemirror/language'
import {
  EditorState,
  Facet,
  StateEffect,
  StateField,
  type Extension,
  type Range,
} from '@codemirror/state'
import { Decoration, EditorView, WidgetType, type DecorationSet } from '@codemirror/view'
import type { SyntaxNode } from '@lezer/common'
import { tags } from '@lezer/highlight'
import { imageExtension } from './live-images.ts'
import { TableWidget } from './table-widget.ts'

/**
 * Obsidian-style live preview (PLAN 6.5): CodeMirror decorations and widgets over the Markdown syntax tree. Markup
 * is hidden and styled on every line the cursor is not on; the document itself is never touched, so the saved text
 * is exactly what was typed (the one exception is a task checkbox, whose toggle is an explicit edit).
 */

export type LivePreviewOptions = {
  /** Ctrl/Cmd-click on a `[[wikilink]]`, or a click on one inside a rendered table. */
  onOpenWikilink: (target: string) => void
  /** True when no note matches, so the link is drawn as missing. */
  isMissing: (target: string) => boolean
}

const options = Facet.define<LivePreviewOptions, LivePreviewOptions>({
  combine: (values) => values[0] ?? { onOpenWikilink: () => undefined, isMissing: () => false },
})

/** The editor shows source on the cursor's line only while it has focus, so a freshly opened note is fully rendered. */
export const setLiveFocus = StateEffect.define<boolean>()
/** Re-evaluates which wikilinks are missing (the note list changed). */
export const refreshLive = StateEffect.define<null>()

type LiveState = { focused: boolean; decorations: DecorationSet }

const WIKILINK = /\[\[([^\]\n|]+?)(?:\|([^\]\n]+?))?\]\]/g
const CALLOUT = /^(\s*(?:>\s?)+)\[!([A-Za-z]+)\]([+-]?)/

const hide = Decoration.replace({})

class TextWidget extends WidgetType {
  constructor(
    private readonly text: string,
    private readonly className: string,
  ) {
    super()
  }
  override eq(other: TextWidget) {
    return other.text === this.text && other.className === this.className
  }
  override toDOM() {
    const span = document.createElement('span')
    span.className = this.className
    span.textContent = this.text
    return span
  }
}

class RuleWidget extends WidgetType {
  override eq() {
    return true
  }
  override toDOM() {
    const span = document.createElement('span')
    span.className = 'cm-lp-hr'
    return span
  }
}

class CheckboxWidget extends WidgetType {
  constructor(
    private readonly checked: boolean,
    private readonly label: string,
  ) {
    super()
  }
  override eq(other: CheckboxWidget) {
    return other.checked === this.checked && other.label === this.label
  }
  override toDOM(view: EditorView) {
    const box = document.createElement('button')
    box.type = 'button'
    box.className = 'cm-lp-check'
    box.setAttribute('role', 'checkbox')
    box.setAttribute('aria-checked', String(this.checked))
    box.setAttribute('aria-label', this.label)
    if (this.checked) box.textContent = '✓'
    // Keep the caret where it is: the click is a command, not a cursor move.
    box.addEventListener('mousedown', (event) => event.preventDefault())
    box.addEventListener('click', (event) => {
      event.preventDefault()
      toggleTask(view, view.posAtDOM(box))
    })
    return box
  }
  override ignoreEvent() {
    return true
  }
}

/** Flips `[ ]` / `[x]` at `pos`; the only change is the one character between the brackets. */
export function toggleTask(view: EditorView, pos: number): boolean {
  const marker = view.state.doc.sliceString(pos, pos + 3)
  if (!/^\[[ xX]\]$/.test(marker)) return false
  view.dispatch({ changes: { from: pos + 1, to: pos + 2, insert: marker[1] === ' ' ? 'x' : ' ' } })
  return true
}

const CALLOUT_KIND: Record<string, string> = {
  note: 'note',
  info: 'note',
  abstract: 'note',
  summary: 'note',
  todo: 'note',
  tip: 'tip',
  hint: 'tip',
  success: 'tip',
  check: 'tip',
  done: 'tip',
  warning: 'warn',
  caution: 'warn',
  attention: 'warn',
  question: 'warn',
  danger: 'danger',
  error: 'danger',
  bug: 'danger',
  failure: 'danger',
  fail: 'danger',
}
export const calloutKind = (name: string) => CALLOUT_KIND[name.toLowerCase()] ?? 'note'

function lineSet(state: EditorState): Set<number> {
  const lines = new Set<number>()
  for (const range of state.selection.ranges) {
    const first = state.doc.lineAt(range.from).number
    const last = state.doc.lineAt(range.to).number
    for (let n = first; n <= last; n += 1) lines.add(n)
  }
  return lines
}

function build(state: EditorState, focused: boolean): DecorationSet {
  const doc = state.doc
  const active = focused ? lineSet(state) : new Set<number>()
  const touches = (from: number, to: number) => {
    const first = doc.lineAt(from).number
    const last = doc.lineAt(to).number
    for (let n = first; n <= last; n += 1) if (active.has(n)) return true
    return false
  }
  const out: Range<Decoration>[] = []
  const lineDeco = (from: number, className: string) =>
    out.push(Decoration.line({ class: className }).range(doc.lineAt(from).from))
  const markDeco = (
    from: number,
    to: number,
    className: string,
    attrs?: Record<string, string>,
  ) => {
    if (to > from)
      out.push(Decoration.mark({ class: className, attributes: attrs }).range(from, to))
  }
  const hideRange = (from: number, to: number) => {
    if (to > from) out.push(hide.range(from, to))
  }
  const protectedRanges: [number, number][] = []

  const tree = ensureSyntaxTree(state, doc.length, 300)
  if (!tree) return Decoration.none

  tree.iterate({
    enter: (ref) => {
      const node = ref.node
      const name = node.name
      const inactive = !touches(node.from, node.to)
      const heading = /^ATXHeading([1-6])$/.exec(name)
      if (heading) {
        lineDeco(node.from, `cm-lp-h cm-lp-h${heading[1]}`)
        const mark = node.getChild('HeaderMark')
        if (mark && inactive) {
          const line = doc.lineAt(mark.to)
          hideRange(mark.from, Math.min(mark.to + 1, line.to))
        }
        return
      }
      switch (name) {
        case 'Emphasis':
          markDeco(node.from, node.to, 'cm-lp-em')
          break
        case 'StrongEmphasis':
          markDeco(node.from, node.to, 'cm-lp-strong')
          break
        case 'Strikethrough':
          markDeco(node.from, node.to, 'cm-lp-strike')
          break
        case 'InlineCode':
          markDeco(node.from, node.to, 'cm-lp-code-inline')
          protectedRanges.push([node.from, node.to])
          break
        case 'EmphasisMark':
        case 'StrikethroughMark':
        case 'CodeMark':
          if (node.parent?.name !== 'FencedCode' && !touches(node.from, node.to))
            hideRange(node.from, node.to)
          break
        case 'Link': {
          // `[[wikilinks]]` are handled below, from the text.
          const before = node.from > 0 ? doc.sliceString(node.from - 1, node.from) : ''
          const after = doc.sliceString(node.to, node.to + 1)
          const nested = doc.sliceString(node.from, node.from + 2) === '[['
          if (nested || before === '[' || after === ']') break
          const marks = node.getChildren('LinkMark')
          const url = node.getChild('URL')
          if (marks.length < 2) break
          markDeco(marks[0]!.to, marks[1]!.from, 'cm-lp-link')
          if (inactive) {
            hideRange(marks[0]!.from, marks[0]!.to)
            hideRange(marks[1]!.from, node.to)
          }
          if (url) protectedRanges.push([url.from, url.to])
          break
        }
        case 'Blockquote': {
          const first = doc.lineAt(node.from)
          const callout = CALLOUT.exec(first.text)
          const kind = callout ? calloutKind(callout[2]!) : null
          const last = doc.lineAt(node.to).number
          for (let n = first.number; n <= last; n += 1) {
            const line = doc.line(n)
            lineDeco(
              line.from,
              kind
                ? `cm-lp-callout cm-lp-callout-${kind}${n === first.number ? ' cm-lp-callout-first' : ''}${n === last ? ' cm-lp-callout-last' : ''}`
                : 'cm-lp-quote',
            )
          }
          if (callout && inactive) {
            const start = first.from + callout[1]!.length
            const end = start + callout[0].length - callout[1]!.length
            out.push(
              Decoration.replace({
                widget: new TextWidget(callout[2]!.toLowerCase(), 'cm-lp-callout-label'),
              }).range(start, end),
            )
          }
          break
        }
        case 'QuoteMark':
          if (!touches(node.from, node.to)) {
            const line = doc.lineAt(node.to)
            hideRange(node.from, Math.min(node.to + 1, line.to))
          }
          break
        case 'HorizontalRule':
          if (inactive && node.parent?.name === 'Document')
            out.push(Decoration.replace({ widget: new RuleWidget() }).range(node.from, node.to))
          break
        case 'ListItem': {
          const mark = node.getChild('ListMark')
          const taskMarker = node.getChild('Task')?.getChild('TaskMarker') ?? null
          if (!mark) break
          const bullet = node.parent?.name === 'BulletList'
          const line = doc.lineAt(mark.from)
          if (line.number !== doc.lineAt(node.from).number || active.has(line.number)) break
          if (taskMarker) {
            if (bullet) hideRange(mark.from, mark.to)
          } else if (bullet) {
            out.push(
              Decoration.replace({ widget: new TextWidget('•', 'cm-lp-bullet') }).range(
                mark.from,
                mark.to,
              ),
            )
          }
          break
        }
        case 'TaskMarker': {
          const line = doc.lineAt(node.from)
          if (active.has(line.number)) break
          const checked = /x/i.test(doc.sliceString(node.from, node.to))
          const text = doc.sliceString(node.to, line.to).trim()
          out.push(
            Decoration.replace({
              widget: new CheckboxWidget(checked, text ? `Task: ${text}` : 'Task'),
            }).range(node.from, node.to),
          )
          if (checked) markDeco(node.to, line.to, 'cm-lp-done')
          break
        }
        case 'FencedCode': {
          const first = doc.lineAt(node.from)
          const last = doc.lineAt(node.to)
          const open = !touches(node.from, node.to)
          protectedRanges.push([node.from, node.to])
          for (let n = first.number; n <= last.number; n += 1) {
            const line = doc.line(n)
            const edge =
              n === first.number
                ? ' cm-lp-fence-first'
                : n === last.number
                  ? ' cm-lp-fence-last'
                  : ''
            lineDeco(line.from, `cm-lp-block${edge}`)
          }
          if (open) {
            const marks = node.getChildren('CodeMark')
            const info = node.getChild('CodeInfo')
            if (marks[0]) hideRange(marks[0].from, info ? info.from : marks[0].to)
            if (info) markDeco(info.from, info.to, 'cm-lp-lang')
            // The closing fence line stays (an empty padded line closes the block) but its backticks are hidden.
            if (marks.length > 1 && last.number !== first.number) hideRange(last.from, last.to)
          }
          return false
        }
        case 'CodeBlock':
          for (let n = doc.lineAt(node.from).number; n <= doc.lineAt(node.to).number; n += 1)
            lineDeco(doc.line(n).from, 'cm-lp-block')
          protectedRanges.push([node.from, node.to])
          return false
        case 'Table': {
          if (node.parent?.name !== 'Document') return false
          // Always the rendered grid, also while the caret is in it: cells are edited in place (PLAN 6.8).
          out.push(
            Decoration.replace({
              widget: new TableWidget(doc.sliceString(node.from, node.to), state.facet(options)),
              block: true,
            }).range(node.from, node.to),
          )
          protectedRanges.push([node.from, node.to])
          return false
        }
        case 'Image':
        case 'HTMLBlock':
        case 'HTMLTag':
          protectedRanges.push([node.from, node.to])
          return false
      }
      return undefined
    },
  })

  // Wikilinks come from the text (Lezer reads `[[a]]` as a link reference). Code and tables are left alone.
  const isProtected = (from: number) => protectedRanges.some(([a, b]) => from >= a && from < b)
  const opts = state.facet(options)
  for (let n = 1; n <= doc.lines; n += 1) {
    const line = doc.line(n)
    if (!line.text.includes('[[')) continue
    WIKILINK.lastIndex = 0
    for (const found of line.text.matchAll(WIKILINK)) {
      const from = line.from + found.index
      const to = from + found[0].length
      if (isProtected(from)) continue
      const target = found[1]!.trim()
      const label = found[2] ?? found[1]!
      const labelFrom = from + 2 + (found[2] !== undefined ? found[1]!.length + 1 : 0)
      const missing = opts.isMissing(target)
      markDeco(
        labelFrom,
        labelFrom + label.length,
        `cm-lp-wikilink${missing ? ' is-missing' : ''}`,
        {
          'data-wikilink': target,
        },
      )
      if (!active.has(n)) {
        hideRange(from, labelFrom)
        hideRange(labelFrom + label.length, to)
      }
    }
  }
  return Decoration.set(out, true)
}

const liveField = StateField.define<LiveState>({
  create: (state) => ({ focused: false, decorations: build(state, false) }),
  update(value, tr) {
    let focused = value.focused
    let forced = false
    for (const effect of tr.effects) {
      if (effect.is(setLiveFocus)) focused = effect.value
      if (effect.is(refreshLive)) forced = true
    }
    if (!tr.docChanged && !tr.selection && focused === value.focused && !forced) return value
    return { focused, decorations: build(tr.state, focused) }
  },
  provide: (field) => EditorView.decorations.from(field, (value) => value.decorations),
})

/** Opens the wikilink or Markdown link under a Ctrl/Cmd-click. */
function openLinkAt(view: EditorView, pos: number): boolean {
  const line = view.state.doc.lineAt(pos)
  WIKILINK.lastIndex = 0
  for (const found of line.text.matchAll(WIKILINK)) {
    const from = line.from + found.index
    if (pos >= from && pos <= from + found[0].length) {
      view.state.facet(options).onOpenWikilink(found[1]!.trim())
      return true
    }
  }
  const tree = ensureSyntaxTree(view.state, pos + 1, 50)
  let node: SyntaxNode | null = tree?.resolveInner(pos, 1) ?? null
  while (node && node.name !== 'Link') node = node.parent
  const url = node?.getChild('URL')
  if (!url) return false
  const href = view.state.doc.sliceString(url.from, url.to)
  if (!/^(https?:|mailto:)/i.test(href)) return false
  window.open(href, '_blank', 'noopener,noreferrer')
  return true
}

// Markup that is showing (the cursor's line) is dimmed so the words stand out.
const markupStyle = HighlightStyle.define([
  { tag: [tags.processingInstruction, tags.meta, tags.contentSeparator], color: 'var(--muted)' },
])

export function livePreview(opts: LivePreviewOptions): Extension {
  return [
    syntaxHighlighting(markupStyle),
    options.of(opts),
    liveField,
    imageExtension('widget'),
    EditorView.editorAttributes.of({ class: 'cm-live' }),
    EditorView.focusChangeEffect.of((_state, focusing) => setLiveFocus.of(focusing)),
    EditorView.domEventHandlers({
      mousedown(event, view) {
        if (!(event.ctrlKey || event.metaKey)) return false
        const pos = view.posAtCoords({ x: event.clientX, y: event.clientY })
        if (pos === null || !openLinkAt(view, pos)) return false
        event.preventDefault()
        return true
      },
    }),
  ]
}

/** Source mode (PLAN 6.8): plain Markdown, no formatting; embedded images collapse to a chip. */
export function sourceMode(): Extension {
  return [imageExtension('chip'), EditorView.editorAttributes.of({ class: 'cm-source' })]
}
