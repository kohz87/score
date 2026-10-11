import type { EditorState } from '@codemirror/state'
import { EditorView } from '@codemirror/view'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { useState } from 'react'
import { afterEach, beforeAll, beforeEach, describe, expect, test, vi } from 'vitest'
import type { KnowledgeNoteSummary } from '@score/contract'
import { EditorToolbar } from './EditorToolbar.tsx'
import { MarkdownEditor } from './MarkdownEditor.tsx'

const NOTES: KnowledgeNoteSummary[] = [
  { path: 'projects/Plan.md', title: 'Plan', mtime: '', lastAuthor: null },
]

let latest = ''
function Harness({ initial, source = false }: { initial: string; source?: boolean }) {
  const [view, setView] = useState<EditorView | null>(null)
  const [state, setState] = useState<EditorState | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [link, setLink] = useState(0)
  return (
    <>
      <EditorToolbar
        view={view}
        state={state}
        notes={NOTES}
        notice={notice}
        onNotice={setNotice}
        linkRequest={link}
      />
      <MarkdownEditor
        initial={initial}
        label="Contents"
        notes={() => NOTES}
        onChange={(text) => (latest = text)}
        source={source}
        onView={setView}
        onState={setState}
        onNotice={setNotice}
        onShortcut={() => setLink((n) => n + 1)}
      />
    </>
  )
}
const editor = () => EditorView.findFromDOM(document.querySelector<HTMLElement>('.cm-editor')!)!
const button = (name: string) => screen.getByRole('button', { name })
const select = (from: number, to = from) =>
  act(() => editor().dispatch({ selection: { anchor: from, head: to } }))
const doc = () => editor().state.doc.toString()

// jsdom has no layout: CodeMirror's measuring needs these to exist.
beforeAll(() => {
  const none = { length: 0, item: () => null, [Symbol.iterator]: [][Symbol.iterator] }
  Range.prototype.getClientRects = () => none as unknown as DOMRectList
  Range.prototype.getBoundingClientRect = () => new DOMRect()
})

beforeEach(() => {
  latest = ''
})
afterEach(cleanup)

describe('formatting buttons', () => {
  test('toggle the selection and show their state; each has a name, a tooltip and a shortcut', async () => {
    render(<Harness initial="make this bold" />)
    await screen.findByRole('toolbar', { name: 'Formatting' })
    select(5, 9)
    const bold = button('Bold')
    expect(bold.getAttribute('aria-pressed')).toBe('false')
    expect(bold.title).toMatch(/Bold \((Ctrl|⌘)\+B\)/)
    fireEvent.click(bold)
    expect(doc()).toBe('make **this** bold')
    expect(latest).toBe('make **this** bold')
    await waitFor(() => expect(button('Bold').getAttribute('aria-pressed')).toBe('true'))
    fireEvent.click(button('Bold'))
    expect(doc()).toBe('make this bold')
    await waitFor(() => expect(button('Bold').getAttribute('aria-pressed')).toBe('false'))
  })

  test('lists, quote and undo / redo', async () => {
    render(<Harness initial={'one\ntwo'} />)
    await screen.findByRole('toolbar', { name: 'Formatting' })
    expect((button('Undo') as HTMLButtonElement).disabled).toBe(true)
    select(0, 7)
    fireEvent.click(button('Bulleted list'))
    expect(doc()).toBe('- one\n- two')
    await waitFor(() => expect(button('Bulleted list').getAttribute('aria-pressed')).toBe('true'))
    fireEvent.click(button('Checklist'))
    expect(doc()).toBe('- [ ] one\n- [ ] two')
    // The two quick edits are one undo step.
    fireEvent.click(button('Undo'))
    expect(doc()).toBe('one\ntwo')
    fireEvent.click(button('Redo'))
    expect(doc()).toBe('- [ ] one\n- [ ] two')
  })

  test('keyboard shortcuts work in the editor', async () => {
    render(<Harness initial="word" />)
    await screen.findByRole('toolbar', { name: 'Formatting' })
    select(0, 4)
    fireEvent.keyDown(editor().contentDOM, { key: 'b', ctrlKey: true })
    expect(doc()).toBe('**word**')
  })

  test('the heading menu sets a level and marks it', async () => {
    render(<Harness initial="Title" />)
    await screen.findByRole('toolbar', { name: 'Formatting' })
    select(2)
    fireEvent.click(button('Heading'))
    const menu = screen.getByRole('group', { name: 'Heading level' })
    fireEvent.click(within(menu).getByRole('button', { name: 'Heading 2' }))
    expect(doc()).toBe('## Title')
    expect(screen.queryByRole('group', { name: 'Heading level' })).toBeNull()
  })

  test('code block language and callout type menus', async () => {
    render(<Harness initial="" />)
    await screen.findByRole('toolbar', { name: 'Formatting' })
    fireEvent.click(button('Code block'))
    fireEvent.click(
      within(screen.getByRole('group', { name: 'Code block language' })).getByRole('button', {
        name: 'Python',
      }),
    )
    expect(doc()).toContain('```python')
    fireEvent.click(button('Callout'))
    fireEvent.click(
      within(screen.getByRole('group', { name: 'Callout type' })).getByRole('button', {
        name: 'Warning',
      }),
    )
    expect(doc()).toContain('> [!warning]')
  })

  test('Escape closes a menu and puts focus back on its button', async () => {
    render(<Harness initial="x" />)
    await screen.findByRole('toolbar', { name: 'Formatting' })
    const heading = button('Heading')
    heading.focus()
    fireEvent.click(heading)
    expect(heading.getAttribute('aria-expanded')).toBe('true')
    fireEvent.keyDown(screen.getByRole('group', { name: 'Heading level' }), { key: 'Escape' })
    expect(screen.queryByRole('group', { name: 'Heading level' })).toBeNull()
    expect(document.activeElement).toBe(heading)
  })

  test('arrow keys move along the toolbar with one tab stop', async () => {
    render(<Harness initial="x" />)
    const bar = await screen.findByRole('toolbar', { name: 'Formatting' })
    const stops = within(bar)
      .getAllByRole('button')
      .filter((b) => !b.disabled && b.tabIndex === 0)
    expect(stops).toHaveLength(1)
    stops[0]!.focus()
    fireEvent.keyDown(stops[0]!, { key: 'ArrowRight' })
    expect(document.activeElement).not.toBe(stops[0])
    expect(bar.contains(document.activeElement)).toBe(true)
  })
})

describe('links', () => {
  test('a web link from the dialog; a bad address is explained, not inserted', async () => {
    render(<Harness initial="see docs" />)
    await screen.findByRole('toolbar', { name: 'Formatting' })
    select(4, 8)
    fireEvent.click(button('Link'))
    const form = screen.getByRole('form', { name: 'Insert link' })
    expect((within(form).getByLabelText('Text') as HTMLInputElement).value).toBe('docs')
    fireEvent.change(within(form).getByLabelText('Address'), { target: { value: 'nonsense' } })
    fireEvent.click(within(form).getByRole('button', { name: 'Insert link' }))
    expect((await within(form).findByRole('alert')).textContent).toMatch(/web address/)
    expect(doc()).toBe('see docs')
    fireEvent.change(within(form).getByLabelText('Address'), { target: { value: 'example.com/a' } })
    fireEvent.click(within(form).getByRole('button', { name: 'Insert link' }))
    expect(doc()).toBe('see [docs](https://example.com/a)')
    expect(screen.queryByRole('form', { name: 'Insert link' })).toBeNull()
  })

  test('a link to another note becomes a wikilink, and the shortcut opens the dialog', async () => {
    render(<Harness initial="go" />)
    await screen.findByRole('toolbar', { name: 'Formatting' })
    select(0, 2)
    fireEvent.keyDown(editor().contentDOM, { key: 'k', ctrlKey: true, altKey: true })
    const form = await screen.findByRole('form', { name: 'Insert link' })
    fireEvent.click(within(form).getByRole('radio', { name: 'Another note' }))
    fireEvent.change(within(form).getByLabelText('Note'), { target: { value: 'Plan' } })
    fireEvent.click(within(form).getByRole('button', { name: 'Insert link' }))
    expect(doc()).toBe('[[Plan|go]]')
  })
})

describe('tables', () => {
  test('the size grid inserts a table; row and column buttons keep it canonical GFM; Tab moves between cells', async () => {
    render(<Harness initial="" />)
    await screen.findByRole('toolbar', { name: 'Formatting' })
    fireEvent.click(button('Table'))
    fireEvent.click(screen.getByRole('button', { name: '2 columns by 3 rows' }))
    expect(doc()).toBe('| Column 1 | Column 2 |\n| --- | --- |\n|  |  |\n|  |  |\n')
    // The table strip appears while the caret is in a table.
    const strip = await screen.findByRole('toolbar', { name: 'Table' })
    fireEvent.click(within(strip).getByRole('button', { name: 'Add row below' }))
    expect(doc().trim().split('\n')).toHaveLength(5)
    fireEvent.click(within(strip).getByRole('button', { name: 'Add column right' }))
    expect(doc().split('\n')[0]).toBe('| Column 1 | Column 3 | Column 2 |')
    fireEvent.click(within(strip).getByRole('button', { name: 'Align column center' }))
    expect(doc().split('\n')[1]).toBe(
      '| --- | :---: | --- |'.replace('--- | :---: |', '--- | :---: |'),
    )
    fireEvent.keyDown(editor().contentDOM, { key: 'Tab' })
    const main = editor().state.selection.main
    expect(main.head).toBeGreaterThan(0)
  })

  test('the table strip is only there while the caret is in a table', async () => {
    render(<Harness initial={'text\n\n| a | b |\n| --- | --- |\n| 1 | 2 |\n'} />)
    await screen.findByRole('toolbar', { name: 'Formatting' })
    select(1)
    await waitFor(() => expect(screen.queryByRole('toolbar', { name: 'Table' })).toBeNull())
    select('text\n\n| a'.length)
    expect(await screen.findByRole('toolbar', { name: 'Table' })).toBeDefined()
  })
})

describe('images', () => {
  beforeEach(() => {
    vi.stubGlobal('createImageBitmap', async () => ({
      width: 3200,
      height: 1600,
      close: () => undefined,
    }))
    vi.spyOn(HTMLCanvasElement.prototype, 'getContext').mockImplementation(
      () =>
        ({
          drawImage: () => undefined,
          getImageData: () => ({ data: new Uint8ClampedArray([0, 0, 0, 255]) }),
        }) as unknown as CanvasRenderingContext2D,
    )
    vi.spyOn(HTMLCanvasElement.prototype, 'toBlob').mockImplementation(function (
      this: HTMLCanvasElement,
      callback,
      type,
    ) {
      callback(
        new Blob([new Uint8Array([0x89, 0x50, 0x4e, 0x47, 1, 2, 3, 4])], {
          type: type ?? 'image/png',
        }),
      )
    })
  })
  afterEach(() => {
    vi.unstubAllGlobals()
    vi.restoreAllMocks()
  })
  const pngFile = (name = 'diagram.png') => {
    const bytes = new Uint8Array(32)
    bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
    return new File([bytes], name, { type: 'image/png' })
  }

  test('the Image button picks a file: downscaled, embedded as a data URI, shown as a picture without the base64', async () => {
    render(<Harness initial="intro" />)
    await screen.findByRole('toolbar', { name: 'Formatting' })
    select(5)
    fireEvent.change(screen.getByTestId('image-input'), { target: { files: [pngFile()] } })
    await waitFor(() => expect(doc()).toMatch(/!\[diagram\]\(data:image\/png;base64,/))
    expect(latest).toBe(doc())
    await waitFor(() => expect(document.querySelector('.cm-lp-image img')).not.toBeNull())
    expect(editor().dom.textContent).not.toContain('base64')
  })

  test('pasting an image file embeds it; pasting text alongside leaves the text alone', async () => {
    render(<Harness initial="" />)
    await screen.findByRole('toolbar', { name: 'Formatting' })
    const paste = (files: File[], text: string) => {
      const event = new Event('paste', { bubbles: true, cancelable: true }) as Event & {
        clipboardData: unknown
      }
      event.clipboardData = {
        files,
        getData: (type: string) => (type === 'text/plain' ? text : ''),
      }
      editor().contentDOM.dispatchEvent(event)
      return event.defaultPrevented
    }
    paste([pngFile('cell.png')], 'A1\tB1')
    expect(doc()).not.toContain('data:image')
    expect(paste([pngFile('Screenshot 1.png')], '')).toBe(true)
    await waitFor(() => expect(doc()).toMatch(/!\[Screenshot 1\]\(data:image\/png;base64,/))
  })

  test('dropping an image onto the editor embeds it', async () => {
    render(<Harness initial="" />)
    await screen.findByRole('toolbar', { name: 'Formatting' })
    const event = new Event('drop', { bubbles: true, cancelable: true }) as Event & {
      dataTransfer: unknown
    }
    event.dataTransfer = { files: [pngFile('dropped.png')] }
    editor().contentDOM.dispatchEvent(event)
    expect(event.defaultPrevented).toBe(true)
    await waitFor(() => expect(doc()).toMatch(/^!\[dropped\]\(data:image\/png;base64,/))
  })

  test('an SVG is refused with a message and nothing is inserted', async () => {
    render(<Harness initial="keep" />)
    await screen.findByRole('toolbar', { name: 'Formatting' })
    const svg = new File(['<svg xmlns="http://www.w3.org/2000/svg"/>'], 'logo.svg', {
      type: 'image/svg+xml',
    })
    fireEvent.change(screen.getByTestId('image-input'), { target: { files: [svg] } })
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toMatch(/SVG is not allowed/)
    expect(doc()).toBe('keep')
    fireEvent.click(within(alert).getByRole('button', { name: 'Dismiss' }))
    expect(screen.queryByRole('alert')).toBeNull()
  })
})
