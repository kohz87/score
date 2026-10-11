import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { EditorSelection, EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, describe, expect, test } from 'vitest'
import {
  activeFormats,
  alignColumn,
  applyTableOp,
  insertImages,
  insertLink,
  insertRule,
  insertTable,
  setCallout,
  setHeading,
  tableAt,
  tableTab,
  toggleCodeBlock,
  toggleInline,
  toggleList,
  toggleQuote,
} from './editor-commands.ts'

let view: EditorView | null = null
afterEach(() => {
  view?.destroy()
  view = null
})
/** `|` marks the caret; `[` `]` pairs are not used: pass a range for selections. */
function make(doc: string, from?: number, to?: number): EditorView {
  view?.destroy()
  const caret = from ?? doc.length
  view = new EditorView({
    parent: document.body,
    state: EditorState.create({
      doc,
      selection: EditorSelection.single(caret, to ?? caret),
      extensions: [markdown({ base: markdownLanguage })],
    }),
  })
  return view
}
const text = () => view!.state.doc.toString()

describe('inline formats', () => {
  test('bold wraps the selection, and again unwraps it', () => {
    make('make this bold', 5, 9)
    toggleInline(view!, 'bold')
    expect(text()).toBe('make **this** bold')
    expect(activeFormats(view!.state).bold).toBe(true)
    toggleInline(view!, 'bold')
    expect(text()).toBe('make this bold')
    expect(activeFormats(view!.state).bold).toBe(false)
  })

  test('with only a caret the word is wrapped; on empty text the marks go in and the caret between', () => {
    make('one two', 5)
    toggleInline(view!, 'italic')
    expect(text()).toBe('one *two*')
    make('', 0)
    toggleInline(view!, 'code')
    expect(text()).toBe('``')
    expect(view!.state.selection.main.head).toBe(1)
  })

  test('strikethrough and inline code toggle and show active', () => {
    make('a b c', 2, 3)
    toggleInline(view!, 'strike')
    expect(text()).toBe('a ~~b~~ c')
    expect(activeFormats(view!.state).strike).toBe(true)
    toggleInline(view!, 'strike')
    make('x y', 2, 3)
    toggleInline(view!, 'code')
    expect(text()).toBe('x `y`')
    expect(activeFormats(view!.state).code).toBe(true)
    toggleInline(view!, 'code')
    expect(text()).toBe('x y')
  })
})

describe('line formats', () => {
  test('bullet, numbered and checkbox lists toggle and switch', () => {
    make('one\ntwo\nthree', 0, 13)
    toggleList(view!, 'bullet')
    expect(text()).toBe('- one\n- two\n- three')
    expect(activeFormats(view!.state).bullet).toBe(true)
    toggleList(view!, 'numbered')
    expect(text()).toBe('1. one\n2. two\n3. three')
    toggleList(view!, 'task')
    expect(text()).toBe('- [ ] one\n- [ ] two\n- [ ] three')
    expect(activeFormats(view!.state).task).toBe(true)
    toggleList(view!, 'task')
    expect(text()).toBe('one\ntwo\nthree')
  })

  test('a list toggle skips blank lines and keeps indentation', () => {
    make('a\n\n  b', 0, 6)
    toggleList(view!, 'bullet')
    expect(text()).toBe('- a\n\n  - b')
  })

  test('quote toggles', () => {
    make('hello\nworld', 0, 11)
    toggleQuote(view!)
    expect(text()).toBe('> hello\n> world')
    expect(activeFormats(view!.state).quote).toBe(true)
    toggleQuote(view!)
    expect(text()).toBe('hello\nworld')
  })

  test('headings set, replace and toggle off', () => {
    make('Title', 2)
    setHeading(view!, 2)
    expect(text()).toBe('## Title')
    expect(activeFormats(view!.state).heading).toBe(2)
    setHeading(view!, 1)
    expect(text()).toBe('# Title')
    setHeading(view!, 1)
    expect(text()).toBe('Title')
  })
})

describe('blocks', () => {
  test('a horizontal rule goes on its own lines', () => {
    make('text', 4)
    insertRule(view!)
    expect(text()).toBe('text\n\n---\n')
  })

  test('a code block with a language is inserted with the caret inside, and toggles off', () => {
    make('intro', 5)
    toggleCodeBlock(view!, 'ts')
    expect(text()).toBe('intro\n\n```ts\n\n```\n')
    expect(view!.state.selection.main.head).toBe('intro\n\n```ts\n'.length)
    expect(activeFormats(view!.state).codeBlock).toBe(true)
    toggleCodeBlock(view!)
    expect(text()).toBe('intro\n\n\n')
  })

  test('a code block wraps the selected lines', () => {
    make('a\nb', 0, 3)
    toggleCodeBlock(view!, 'sh')
    expect(text()).toBe('```sh\na\nb\n```')
  })

  test('a callout wraps the selection, and the type menu changes an existing one', () => {
    make('careful here', 0, 12)
    setCallout(view!, 'warning')
    expect(text()).toBe('> [!warning]\n> careful here')
    expect(activeFormats(view!.state).callout).toBe(true)
    setCallout(view!, 'tip')
    expect(text()).toBe('> [!tip]\n> careful here')
    make('', 0)
    setCallout(view!, 'note')
    expect(text()).toBe('> [!note] Note\n> \n')
  })

  test('a web link and a note link', () => {
    make('see docs here', 4, 8)
    insertLink(view!, 'docs', { kind: 'web', url: 'https://example.com/a b' })
    expect(text()).toBe('see [docs](https://example.com/a%20b) here')
    make('go', 0, 2)
    insertLink(view!, 'go', { kind: 'note', target: 'Plan' })
    expect(text()).toBe('[[Plan|go]]')
    make('', 0)
    insertLink(view!, '', { kind: 'note', target: 'Plan' })
    expect(text()).toBe('[[Plan]]')
  })

  test('images are inserted as separate paragraphs', () => {
    make('a b', 1)
    insertImages(view!, ['![x](data:image/png;base64,AAAA)', '![y](data:image/png;base64,BBBB)'])
    expect(text()).toBe('a![x](data:image/png;base64,AAAA)\n\n![y](data:image/png;base64,BBBB) b')
  })
})

describe('tables', () => {
  test('insert makes a GFM table with a header row and selects the first header', () => {
    make('')
    insertTable(view!, 3, 3)
    expect(text()).toBe(
      '| Column 1 | Column 2 | Column 3 |\n| --- | --- | --- |\n|  |  |  |\n|  |  |  |\n',
    )
    const main = view!.state.selection.main
    expect(view!.state.sliceDoc(main.from, main.to)).toBe('Column 1')
    expect(tableAt(view!.state)).not.toBeNull()
  })

  test('size is clamped to 8 by 8', () => {
    make('')
    insertTable(view!, 20, 20)
    const lines = text().trim().split('\n')
    expect(lines).toHaveLength(8 + 1)
    expect(lines[0]!.split('|').length - 2).toBe(8)
  })

  const base = '| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |'
  const at = (line: number, col: number) => {
    let pos = 0
    for (let n = 0; n < line; n += 1) pos += base.split('\n')[n]!.length + 1
    return pos + col
  }

  test('add and remove rows and columns, canonical Markdown each time', () => {
    make(base, at(2, 3))
    applyTableOp(view!, { kind: 'row', where: 'below' })
    expect(text()).toBe('| A | B |\n| --- | --- |\n| 1 | 2 |\n|  |  |\n| 3 | 4 |')
    applyTableOp(view!, { kind: 'delete-row' })
    expect(text()).toBe(base)
    make(base, at(2, 6))
    applyTableOp(view!, { kind: 'column', where: 'right' })
    expect(text()).toBe('| A | B | Column 3 |\n| --- | --- | --- |\n| 1 | 2 |  |\n| 3 | 4 |  |')
    applyTableOp(view!, { kind: 'delete-column' })
    expect(text()).toBe('| A | B |\n| --- | --- |\n| 1 | 2 |\n| 3 | 4 |')
  })

  test('the header row cannot be deleted; a one-column table cannot lose its column', () => {
    make(base, 2)
    expect(applyTableOp(view!, { kind: 'delete-row' })).toBe(false)
    make('| A |\n| --- |\n| 1 |', 2)
    expect(applyTableOp(view!, { kind: 'delete-column' })).toBe(false)
  })

  test('move a column and set its alignment', () => {
    make(base, at(2, 2))
    applyTableOp(view!, { kind: 'move-column', direction: 'right' })
    expect(text()).toBe('| B | A |\n| --- | --- |\n| 2 | 1 |\n| 4 | 3 |')
    expect(applyTableOp(view!, { kind: 'move-column', direction: 'right' })).toBe(false)
    alignColumn(view!, 'center')
    expect(text().split('\n')[1]).toBe('| --- | :---: |')
    alignColumn(view!, 'right')
    expect(text().split('\n')[1]).toBe('| --- | ---: |')
    alignColumn(view!, 'left')
    expect(text().split('\n')[1]).toBe('| --- | :--- |')
    alignColumn(view!, null)
    expect(text().split('\n')[1]).toBe('| --- | --- |')
  })

  test('pipes in cells are escaped when the table is rewritten', () => {
    make('| a \\| b | c |\n| --- | --- |\n| `x \\| y` | z |', 2)
    applyTableOp(view!, { kind: 'row', where: 'below' })
    expect(text()).toBe('| a \\| b | c |\n| --- | --- |\n|  |  |\n| `x \\| y` | z |')
  })

  test('Tab and Shift-Tab move between cells, skip the delimiter row, and the last Tab adds a row', () => {
    make(base, 2)
    const head = () => {
      const { from, to } = view!.state.selection.main
      return view!.state.sliceDoc(from, to)
    }
    tableTab(view!, false)
    expect(head()).toBe('B')
    tableTab(view!, false)
    expect(head()).toBe('1')
    tableTab(view!, false)
    expect(head()).toBe('2')
    tableTab(view!, false)
    expect(head()).toBe('3')
    tableTab(view!, true)
    expect(head()).toBe('2')
    tableTab(view!, true)
    tableTab(view!, true)
    expect(head()).toBe('B')
    tableTab(view!, true)
    expect(head()).toBe('A')
    tableTab(view!, true)
    expect(head()).toBe('A')
    make(base, base.length - 1)
    tableTab(view!, false)
    expect(text()).toBe(`${base}\n|  |  |`)
    expect(tableAt(view!.state)!.cell).toEqual({ row: 3, column: 0 })
  })

  test('a caret on the very first character of a table (where a click on the rendered table puts it) is in the table', () => {
    make(`intro\n\n${base}\n\nafter`, 'intro\n\n'.length)
    expect(tableAt(view!.state)).not.toBeNull()
    expect(activeFormats(view!.state).table).toBe(true)
  })

  test('outside a table nothing happens', () => {
    make('plain')
    expect(tableTab(view!, false)).toBe(false)
    expect(applyTableOp(view!, { kind: 'row', where: 'below' })).toBe(false)
  })
})
