import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, beforeAll, expect, test, vi } from 'vitest'
import { history, undo } from '@codemirror/commands'
import { applyTableOp } from './editor-commands.ts'
import { livePreview, setLiveFocus } from './live-preview.ts'
import { parseTable, splitRow } from './live-table.ts'

// jsdom has no layout: CodeMirror's measuring needs these to exist.
beforeAll(() => {
  const none = { length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }
  Range.prototype.getClientRects = () => none as unknown as DOMRectList
  Range.prototype.getBoundingClientRect = () => new DOMRect()
})

let view: EditorView | null = null
afterEach(() => {
  view?.destroy()
  view = null
  document.body.innerHTML = ''
})

function open(doc: string, missing: string[] = [], tableKey?: string) {
  const parent = document.createElement('div')
  document.body.append(parent)
  view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [
        history(),
        markdown({ base: markdownLanguage }),
        livePreview({
          onOpenWikilink: () => undefined,
          isMissing: (t) => missing.includes(t),
          ...(tableKey ? { tableKey } : {}),
        }),
      ],
    }),
  })
  return view
}
const focus = (v: EditorView, anchor: number) =>
  v.dispatch({ selection: { anchor }, effects: setLiveFocus.of(true) })
const TABLE = '| Name | Qty |\n| --- | ---: |\n| Apples | 3 |\n| `Pears` | **4** |\n'

test('a table is a rendered grid, also while the caret is in it: no raw pipes', () => {
  const v = open(`Intro\n\n${TABLE}\nAfter\n`)
  const table = v.dom.querySelector('.cm-lp-table table')!
  expect(table).not.toBeNull()
  expect([...table.querySelectorAll('th')].map((th) => th.textContent)).toEqual(['Name', 'Qty'])
  expect(table.querySelector('td code')?.textContent).toBe('Pears')
  expect(table.querySelector('td strong')?.textContent).toBe('4')
  expect((table.querySelectorAll('th')[1] as HTMLElement).style.textAlign).toBe('right')

  focus(v, v.state.doc.toString().indexOf('Apples'))
  expect(v.dom.querySelector('.cm-lp-table')).not.toBeNull()
  expect(v.contentDOM.textContent).not.toContain('| Apples')
})

// Table cells are edited in place (PLAN 6.8).
const cell = (v: EditorView, row: number, column: number) =>
  v.dom.querySelector<HTMLElement>(`.cm-lp-cell[data-row="${row}"][data-column="${column}"]`)!
const key = (el: Element, k: string, init: KeyboardEventInit = {}) =>
  el.dispatchEvent(
    new KeyboardEvent('keydown', { key: k, bubbles: true, cancelable: true, ...init }),
  )
const click = (el: Element) =>
  el.dispatchEvent(new MouseEvent('mousedown', { bubbles: true, cancelable: true }))
const input = (v: EditorView) => v.dom.querySelector<HTMLInputElement>('.cm-lp-cell-input')!
const settle = () => new Promise((resolve) => setTimeout(resolve, 40))
const SMALL = '| A | B |\n| --- | --- |\n| 1 | 2 |'

test('clicking a cell opens a labelled single-line input holding its Markdown; the caret follows the cell', () => {
  const v = open(`${TABLE}`)
  click(cell(v, 2, 0))
  const field = input(v)
  expect(field.getAttribute('aria-label')).toBe('Name, row 2')
  expect(field.value).toBe('`Pears`')
  expect(document.activeElement).toBe(field)
  const caret = v.state.selection.main.head
  expect(v.state.doc.sliceString(caret, caret + 7)).toBe('`Pears`')
})

test('Enter saves the cell as one undoable transaction of canonical GFM and edits the cell below', async () => {
  const v = open('| A | B |\n| :-- | --: |\n| 1 | 2 |\n| 3 | 4 |')
  click(cell(v, 1, 0))
  input(v).value = 'x | **y**'
  key(input(v), 'Enter')
  expect(v.state.doc.toString()).toBe('| A | B |\n| :--- | ---: |\n| x \\| **y** | 2 |\n| 3 | 4 |')
  await settle()
  expect(input(v).value).toBe('3')
  expect(cell(v, 1, 0).querySelector('strong')?.textContent).toBe('y')
  undo(v)
  expect(v.state.doc.toString()).toBe('| A | B |\n| :-- | --: |\n| 1 | 2 |\n| 3 | 4 |')
})

test('an unchanged cell rewrites nothing; Escape cancels an edit', () => {
  const doc = '| A | B |\n|---|---|\n| 1 | 2 |'
  const v = open(doc)
  click(cell(v, 1, 1))
  key(input(v), 'Enter')
  expect(v.state.doc.toString()).toBe(doc)
  click(cell(v, 1, 0))
  input(v).value = 'changed'
  key(input(v), 'Escape')
  expect(v.state.doc.toString()).toBe(doc)
  expect(cell(v, 1, 0).textContent).toBe('1')
})

test('Tab and Shift+Tab move between cells; Tab on the last cell adds a row', async () => {
  const v = open(SMALL)
  click(cell(v, 0, 0))
  key(input(v), 'Tab')
  await settle()
  expect(input(v).value).toBe('B')
  expect(document.activeElement).toBe(input(v))
  expect(input(v).closest('th')).toBe(cell(v, 0, 1))
  key(input(v), 'Tab')
  await settle()
  expect(input(v).value).toBe('1')
  key(input(v), 'Tab', { shiftKey: true })
  expect(input(v).closest('th')).toBe(cell(v, 0, 1))
  click(cell(v, 1, 1))
  key(input(v), 'Tab')
  await settle()
  expect(v.state.doc.toString()).toBe('| A | B |\n| --- | --- |\n| 1 | 2 |\n|  |  |')
  expect(input(v).closest('td')).toBe(cell(v, 2, 0))
})

test('arrow keys move over the grid; typing on a focused cell starts editing it; blur keeps the text', async () => {
  const v = open(SMALL)
  cell(v, 1, 0).focus()
  key(cell(v, 1, 0), 'ArrowRight')
  expect(document.activeElement).toBe(cell(v, 1, 1))
  key(cell(v, 1, 1), 'ArrowUp')
  expect(document.activeElement).toBe(cell(v, 0, 1))
  key(cell(v, 0, 1), 'z')
  expect(input(v).value).toBe('z')
  input(v).dispatchEvent(new FocusEvent('blur'))
  expect(v.state.doc.toString()).toBe('| A | z |\n| --- | --- |\n| 1 | 2 |')
})

test('the toolbar actions work on the focused cell and keep the grid', async () => {
  const v = open(SMALL)
  click(cell(v, 1, 1))
  applyTableOp(v, { kind: 'column', where: 'left' })
  await settle()
  expect(v.state.doc.toString()).toBe('| A | Column 3 | B |\n| --- | --- | --- |\n| 1 |  | 2 |')
  expect(v.dom.querySelector('.cm-lp-table')).not.toBeNull()
})

test('markup hides away from the cursor and comes back on its line', () => {
  const v = open(
    '# Title\n\nSome **bold** and `code` and [[Plan|the plan]].\n\n> [!warning] Careful\n> text\n',
  )
  const text = () => v.contentDOM.textContent ?? ''
  expect(text()).not.toContain('# Title')
  expect(text()).not.toContain('**')
  expect(text()).not.toContain('[[')
  expect(text()).toContain('the plan')
  expect(v.contentDOM.querySelector('.cm-lp-callout-label')?.textContent).toBe('warning')
  expect(v.contentDOM.querySelector('.cm-lp-callout-warn')).not.toBeNull()
  focus(v, 3)
  expect(text()).toContain('# Title')
  expect(text()).not.toContain('**')
  focus(v, v.state.doc.toString().indexOf('bold'))
  expect(text()).toContain('**bold**')
  expect(text()).toContain('[[Plan|the plan]]')
})

test('missing wikilinks are marked', () => {
  const v = open('[[Gone]] and [[Here]]', ['Gone'])
  const links = [...v.contentDOM.querySelectorAll('.cm-lp-wikilink')]
  expect(links.map((l) => [l.textContent, l.classList.contains('is-missing')])).toEqual([
    ['Gone', true],
    ['Here', false],
  ])
})

test('a task checkbox toggles the source and is a named checkbox', () => {
  const v = open('- [ ] write tests\n- [x] ship\n')
  const boxes = [...v.contentDOM.querySelectorAll<HTMLElement>('[role="checkbox"]')]
  expect(boxes.map((b) => b.getAttribute('aria-checked'))).toEqual(['false', 'true'])
  expect(boxes[0]!.getAttribute('aria-label')).toBe('Task: write tests')
  boxes[0]!.click()
  expect(v.state.doc.toString()).toBe('- [x] write tests\n- [x] ship\n')
  v.contentDOM.querySelectorAll<HTMLElement>('[role="checkbox"]')[1]!.click()
  expect(v.state.doc.toString()).toBe('- [x] write tests\n- [ ] ship\n')
})

test('the text stays byte-for-byte what was typed while editing around decorations', () => {
  const doc = `# Title\n\n${TABLE}\n- [ ] task\n\n---\n\n\`\`\`ts\nconst a = 1\n\`\`\`\n`
  const v = open(doc)
  expect(v.state.doc.toString()).toBe(doc)
  focus(v, 3)
  v.dispatch({ changes: { from: 7, insert: ' more' } })
  v.dispatch({ changes: { from: v.state.doc.length, insert: 'tail' } })
  v.dispatch({ selection: { anchor: v.state.doc.toString().indexOf('Apples') } })
  v.dispatch({ changes: { from: v.state.doc.toString().indexOf('3 |'), insert: '1' } })
  const expected = doc.replace('# Title', '# Title more').replace('| 3 |', '| 13 |').concat('tail')
  expect(v.state.doc.toString()).toBe(expected)
})

test('code blocks, rules and bullets get their widgets', () => {
  const v = open('```ts\nconst a = 1\n```\n\n---\n\n- item\n')
  expect(v.contentDOM.querySelectorAll('.cm-lp-block').length).toBe(3)
  expect(v.contentDOM.querySelector('.cm-lp-hr')).not.toBeNull()
  expect(v.contentDOM.querySelector('.cm-lp-bullet')).not.toBeNull()
  expect(v.contentDOM.textContent).not.toContain('```')
})

test('table parsing handles escaped pipes, code and alignment', () => {
  expect(splitRow('| a \\| b | `x | y` | c |')).toEqual(['a | b', '`x | y`', 'c'])
  const parsed = parseTable('a | b\n:-: | --:\n1 | 2\n')!
  expect(parsed.align).toEqual(['center', 'right'])
  expect(parsed.rows).toEqual([['1', '2']])
  expect(parseTable('just text\nmore text')).toBeNull()
})

test('a toolbar action saves the text being typed first, then acts on that cell', () => {
  const v = open(SMALL)
  click(cell(v, 0, 1))
  input(v).value = 'Q'
  applyTableOp(v, { kind: 'row', where: 'below' })
  expect(v.state.doc.toString()).toBe('| A | Q |\n| --- | --- |\n|  |  |\n| 1 | 2 |')
})

// 3.8.3 (owner): select a range of cells and copy it; drag a column wider.
test('dragging across cells selects them, Shift+arrow grows the range, Ctrl+C copies what they show', async () => {
  const writeText = vi.fn(async () => undefined)
  Object.defineProperty(navigator, 'clipboard', { value: { writeText }, configurable: true })
  const v = open(TABLE)
  click(cell(v, 1, 0))
  cell(v, 2, 1).dispatchEvent(new MouseEvent('mouseenter'))
  document.dispatchEvent(new MouseEvent('mouseup'))
  const selected = () => v.dom.querySelectorAll('.cm-lp-cell-selected').length
  expect(selected()).toBe(4)
  // Dragging on ended the pressed cell's edit.
  expect(v.dom.querySelector('.cm-lp-cell-input')).toBeNull()
  key(cell(v, 1, 0), 'c', { ctrlKey: true })
  await settle()
  expect(writeText).toHaveBeenCalledWith('Apples\t3\nPears\t4')
  expect(v.dom.querySelector('.cm-lp-table-status')?.textContent).toBe('Copied 4 cells')
  key(cell(v, 1, 0), 'Escape')
  expect(selected()).toBe(0)
  // Shift+arrow from a focused cell.
  key(cell(v, 0, 0), 'ArrowDown', { shiftKey: true })
  expect(selected()).toBe(2)
})

test('typing in a cell and dragging on saves the text and leaves no stale range', async () => {
  const v = open(SMALL)
  click(cell(v, 1, 0))
  input(v).value = 'x'
  cell(v, 1, 1).dispatchEvent(new MouseEvent('mouseenter'))
  document.dispatchEvent(new MouseEvent('mouseup'))
  expect(v.state.doc.toString()).toContain('| x | 2 |')
  await settle()
  expect(v.dom.querySelectorAll('.cm-lp-cell-selected')).toHaveLength(0)
})

test('each header has a width handle; dragged widths are kept per note and a double-click resets them', () => {
  localStorage.clear()
  const v = open(SMALL, [], 'Notes/plan.md')
  expect(v.dom.querySelectorAll('th .cm-lp-col-resize')).toHaveLength(2)
  const table = v.dom.querySelector<HTMLTableElement>('.cm-lp-table table')!
  expect(table.style.tableLayout).toBe('')
  view?.destroy()
  localStorage.setItem('score.tableWidths:Notes/plan.md\u0001A\u0001B', '[180, 90]')
  const again = open(SMALL, [], 'Notes/plan.md')
  const drawn = again.dom.querySelector<HTMLTableElement>('.cm-lp-table table')!
  expect(drawn.style.tableLayout).toBe('fixed')
  expect([...drawn.querySelectorAll('col')].map((col) => col.style.width)).toEqual([
    '180px',
    '90px',
  ])
  again.dom
    .querySelector('th .cm-lp-col-resize')!
    .dispatchEvent(new MouseEvent('dblclick', { bubbles: true, cancelable: true }))
  expect(drawn.style.tableLayout).toBe('')
  expect(localStorage.getItem('score.tableWidths:Notes/plan.md\u0001A\u0001B')).toBeNull()
})
