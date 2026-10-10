import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { afterEach, expect, test } from 'vitest'
import { livePreview, setLiveFocus } from './live-preview.ts'
import { parseTable, splitRow } from './live-table.ts'

let view: EditorView | null = null
afterEach(() => {
  view?.destroy()
  view = null
  document.body.innerHTML = ''
})

function open(doc: string, missing: string[] = []) {
  const parent = document.createElement('div')
  document.body.append(parent)
  view = new EditorView({
    parent,
    state: EditorState.create({
      doc,
      extensions: [
        markdown({ base: markdownLanguage }),
        livePreview({ onOpenWikilink: () => undefined, isMissing: (t) => missing.includes(t) }),
      ],
    }),
  })
  return view
}
const focus = (v: EditorView, anchor: number) =>
  v.dispatch({ selection: { anchor }, effects: setLiveFocus.of(true) })
const TABLE = '| Name | Qty |\n| --- | ---: |\n| Apples | 3 |\n| `Pears` | **4** |\n'

test('a table renders as a widget until the cursor enters it, then shows its source', () => {
  const v = open(`Intro\n\n${TABLE}\nAfter\n`)
  const table = v.dom.querySelector('.cm-lp-table table')!
  expect(table).not.toBeNull()
  expect([...table.querySelectorAll('th')].map((th) => th.textContent)).toEqual(['Name', 'Qty'])
  expect(table.querySelector('td code')?.textContent).toBe('Pears')
  expect(table.querySelector('td strong')?.textContent).toBe('4')
  expect((table.querySelectorAll('th')[1] as HTMLElement).style.textAlign).toBe('right')

  focus(v, 0)
  expect(v.dom.querySelector('.cm-lp-table')).not.toBeNull()
  focus(v, v.state.doc.toString().indexOf('Apples'))
  expect(v.dom.querySelector('.cm-lp-table')).toBeNull()
  expect(v.contentDOM.textContent).toContain('| Apples | 3 |')
  focus(v, v.state.doc.length)
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
