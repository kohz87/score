import type { EditorView } from '@codemirror/view'
import { expect, test, vi } from 'vitest'
import { addImageFiles, imageFilesOf } from './image-insert.ts'
import type { ImageSession } from './knowledge-images.ts'

const png = (name: string) => {
  const bytes = new Uint8Array(16)
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
  return new File([bytes], name)
}
const open = async (): Promise<ImageSession> => ({
  width: 10,
  height: 10,
  hasAlpha: async () => true,
  encode: async (_w, _h, type) => new Blob([new Uint8Array(100)], { type }),
  close: () => undefined,
})
function stubView(length: number) {
  const dispatch = vi.fn()
  const view = {
    dom: { isConnected: true },
    focus: vi.fn(),
    dispatch,
    state: {
      doc: { toString: () => 'x'.repeat(length), length },
      selection: { main: { from: 0, to: 0 } },
    },
  }
  return { view: view as unknown as EditorView, dispatch }
}

test('a note that would pass 8 MiB is refused with a message and nothing is inserted', async () => {
  const { view, dispatch } = stubView(8 * 1024 * 1024 - 10)
  const report = vi.fn()
  await addImageFiles(view, [png('a.png')], report, { open })
  expect(dispatch).not.toHaveBeenCalled()
  expect(report).toHaveBeenLastCalledWith(expect.stringMatching(/8 MiB/))
})

test('files that cannot be used are skipped and named; the others are still added', async () => {
  const { view, dispatch } = stubView(10)
  const report = vi.fn()
  const svg = new File(['<svg/>'], 'logo.svg')
  await addImageFiles(view, [svg, png('ok.png')], report, { open })
  expect(report).toHaveBeenCalledWith(expect.stringMatching(/logo\.svg: .*SVG/))
  const insert = dispatch.mock.calls[0]![0].changes.insert as string
  expect(insert).toMatch(/^!\[ok\]\(data:image\/png;base64,/)
})

test('only image files are taken from a drop or paste', () => {
  const list = [
    new File(['x'], 'a.txt'),
    png('b.png'),
    new File(['y'], 'c.svg', { type: 'image/svg+xml' }),
  ]
  expect(imageFilesOf(list).map((f) => f.name)).toEqual(['b.png', 'c.svg'])
  expect(imageFilesOf(null)).toEqual([])
})
