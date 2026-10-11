import { autocompletion, type CompletionContext } from '@codemirror/autocomplete'
import { defaultKeymap, history, historyKeymap } from '@codemirror/commands'
import { markdown, markdownLanguage } from '@codemirror/lang-markdown'
import { Compartment, EditorState } from '@codemirror/state'
import { EditorView, keymap, placeholder } from '@codemirror/view'
import { useEffect, useRef } from 'react'
import type { KnowledgeNoteSummary } from '@score/contract'
import { scoreTheme } from '../../components/code-editor-theme.ts'
import { baseName, linkTargetFor } from './knowledge-paths.ts'
import { addImageFiles, imageFilesOf } from './image-insert.ts'
import { tableTab, toggleInline, toggleList } from './editor-commands.ts'
import { livePreview, refreshLive, setLiveFocus, sourceMode } from './live-preview.ts'

type Props = {
  initial: string
  label: string
  /** Latest note list for `[[` completion; read on every completion, so it may change without a remount. */
  notes: () => KnowledgeNoteSummary[]
  onChange: (text: string) => void
  /** Ctrl/Cmd-click on a `[[wikilink]]`. */
  onOpenWikilink?: (target: string) => void
  /** True when no note matches the link target (drawn as missing). */
  isMissing?: (target: string) => boolean
  /** Changes when the note list or links changed, so missing/found links are redrawn. */
  refreshKey?: unknown
  /** Plain Markdown: no formatting, images collapse to a chip (PLAN 6.8). Changing it keeps the text and caret. */
  source?: boolean
  /** Shows the note but accepts no edits (a saved version). */
  readOnly?: boolean
  /** The editor, once it exists (null when it is gone), and again with its state after every change or caret move. */
  onView?: (view: EditorView | null) => void
  onState?: (state: EditorState) => void
  /** A problem with a pasted or dropped image, in words; null clears it. */
  onNotice?: (message: string | null) => void
  /** Keyboard shortcuts that need the toolbar's dialog. */
  onShortcut?: (name: 'link') => void
}

// Wikilink autocomplete after `[[` (adapted from the behaviour of the owner's Artemis editor; code written for Score).
export function wikilinkCompletion(notes: () => KnowledgeNoteSummary[]) {
  return (context: CompletionContext) => {
    const match = context.matchBefore(/\[\[[^\]\n]*/)
    if (!match) return null
    const query = match.text.slice(2).toLowerCase()
    const all = notes()
    const options = all
      .filter(
        (note) =>
          query === '' ||
          note.title.toLowerCase().includes(query) ||
          note.path.toLowerCase().includes(query),
      )
      .slice(0, 30)
      .map((note) => {
        const target = linkTargetFor(note, all)
        const after = context.state.doc.sliceString(context.pos, context.pos + 2)
        return {
          label: note.title || baseName(note.path),
          detail: note.path,
          apply: `${target}${after === ']]' ? '' : ']]'}`,
          type: 'text',
        }
      })
    return { from: match.from + 2, options, filter: false }
  }
}

export function MarkdownEditor({
  initial,
  label,
  notes,
  onChange,
  onOpenWikilink,
  isMissing,
  refreshKey,
  source = false,
  readOnly = false,
  onView,
  onState,
  onNotice,
  onShortcut,
}: Props) {
  const host = useRef<HTMLDivElement>(null)
  const latest = useRef({
    notes,
    onChange,
    onOpenWikilink,
    isMissing,
    onView,
    onState,
    onNotice,
    onShortcut,
  })
  useEffect(() => {
    latest.current = {
      notes,
      onChange,
      onOpenWikilink,
      isMissing,
      onView,
      onState,
      onNotice,
      onShortcut,
    }
  })
  const viewRef = useRef<EditorView | null>(null)
  const mode = useRef(new Compartment())
  const access = useRef(new Compartment())
  const initialSource = useRef(source)
  const initialReadOnly = useRef(readOnly)
  useEffect(() => {
    viewRef.current?.dispatch({ effects: refreshLive.of(null) })
  }, [refreshKey])
  // Switching Source on or off swaps the extensions in place: same text, same caret, no remount.
  useEffect(() => {
    const view = viewRef.current
    if (!view) return
    view.dispatch({
      effects: [
        mode.current.reconfigure(modeExtensions(source, latest)),
        setLiveFocus.of(view.hasFocus),
      ],
    })
    latest.current.onState?.(view.state)
  }, [source])
  useEffect(() => {
    viewRef.current?.dispatch({ effects: access.current.reconfigure(accessExtensions(readOnly)) })
  }, [readOnly])
  useEffect(() => {
    const parent = host.current
    if (!parent) return
    const report = (message: string | null) => latest.current.onNotice?.(message)
    const view = new EditorView({
      parent,
      state: EditorState.create({
        doc: initial,
        extensions: [
          history(),
          keymap.of([
            { key: 'Tab', run: (v) => tableTab(v, false) },
            { key: 'Shift-Tab', run: (v) => tableTab(v, true) },
            { key: 'Mod-b', run: (v) => toggleInline(v, 'bold'), preventDefault: true },
            { key: 'Mod-i', run: (v) => toggleInline(v, 'italic'), preventDefault: true },
            { key: 'Mod-e', run: (v) => toggleInline(v, 'code'), preventDefault: true },
            { key: 'Mod-Shift-x', run: (v) => toggleInline(v, 'strike'), preventDefault: true },
            { key: 'Mod-Shift-8', run: (v) => toggleList(v, 'bullet'), preventDefault: true },
            { key: 'Mod-Shift-7', run: (v) => toggleList(v, 'numbered'), preventDefault: true },
            { key: 'Mod-Shift-9', run: (v) => toggleList(v, 'task'), preventDefault: true },
            {
              key: 'Mod-Alt-k',
              run: () => {
                latest.current.onShortcut?.('link')
                return latest.current.onShortcut !== undefined
              },
              preventDefault: true,
            },
            ...defaultKeymap,
            ...historyKeymap,
          ]),
          markdown({ base: markdownLanguage }),
          mode.current.of(modeExtensions(initialSource.current, latest)),
          access.current.of(accessExtensions(initialReadOnly.current)),
          EditorView.lineWrapping,
          placeholder('Write in Markdown. Type [[ to link another note.'),
          autocompletion({
            override: [wikilinkCompletion(() => latest.current.notes())],
            icons: false,
          }),
          EditorView.contentAttributes.of({
            'aria-label': label,
            'aria-multiline': 'true',
            role: 'textbox',
          }),
          EditorView.domEventHandlers({
            paste(event, v) {
              const data = event.clipboardData
              const files = imageFilesOf(data?.files)
              // Text that comes with the picture (a spreadsheet cell, a web page) wins: it is what was meant.
              if (files.length === 0 || (data?.getData('text/plain') ?? '') !== '') return false
              event.preventDefault()
              void addImageFiles(v, files, report)
              return true
            },
            drop(event, v) {
              const files = imageFilesOf(event.dataTransfer?.files)
              if (files.length === 0) return false
              event.preventDefault()
              const pos = v.posAtCoords({ x: event.clientX, y: event.clientY }) ?? undefined
              void addImageFiles(v, files, report, { pos })
              return true
            },
          }),
          EditorView.updateListener.of((update) => {
            if (update.docChanged) latest.current.onChange(update.state.doc.toString())
            if (update.docChanged || update.selectionSet || update.focusChanged)
              latest.current.onState?.(update.state)
          }),
          scoreTheme,
        ],
      }),
    })
    viewRef.current = view
    latest.current.onView?.(view)
    latest.current.onState?.(view.state)
    return () => {
      viewRef.current = null
      latest.current.onView?.(null)
      view.destroy()
    }
    // The editor is remounted (key) when a different text must be loaded.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  return <div ref={host} className="kn-editor-host" />
}

function modeExtensions(
  source: boolean,
  latest: { current: { onOpenWikilink?: Props['onOpenWikilink']; isMissing?: Props['isMissing'] } },
) {
  return source
    ? sourceMode()
    : livePreview({
        onOpenWikilink: (target) => latest.current.onOpenWikilink?.(target),
        isMissing: (target) => latest.current.isMissing?.(target) ?? false,
      })
}

const accessExtensions = (readOnly: boolean) =>
  readOnly ? [EditorState.readOnly.of(true), EditorView.editable.of(false)] : []
