import type { EditorView } from '@codemirror/view'
import { insertImages } from './editor-commands.ts'
import { ImageError, MAX_NOTE_BYTES, prepareImage, type OpenImage } from './knowledge-images.ts'

/**
 * Turns picked, pasted or dropped files into embedded images at the caret (or `pos`). Problems are reported in words
 * and never lose the note: a file that cannot be used is skipped, the rest are still added.
 */
export async function addImageFiles(
  view: EditorView,
  files: File[],
  report: (message: string | null) => void,
  options: { pos?: number; open?: OpenImage } = {},
): Promise<void> {
  report(null)
  const added: string[] = []
  for (const file of files) {
    try {
      added.push((await prepareImage(file, options.open)).markdown)
    } catch (error) {
      report(
        error instanceof ImageError
          ? `${file.name || 'Image'}: ${error.message}.`
          : 'Couldn’t add that image.',
      )
    }
  }
  if (added.length === 0 || !view.dom.isConnected) return
  const current = new TextEncoder().encode(view.state.doc.toString()).length
  const extra = added.reduce((sum, markdown) => sum + markdown.length, 0)
  if (current + extra > MAX_NOTE_BYTES) {
    report('Adding this would make the note larger than 8 MB. Remove an image first.')
    return
  }
  const pos = options.pos === undefined ? undefined : Math.min(options.pos, view.state.doc.length)
  insertImages(view, added, pos)
}

export const imageFilesOf = (list: FileList | readonly File[] | null | undefined): File[] =>
  Array.from(list ?? []).filter(
    (file) => file.type.startsWith('image/') || /\.(png|jpe?g|gif|webp|svg)$/i.test(file.name),
  )
