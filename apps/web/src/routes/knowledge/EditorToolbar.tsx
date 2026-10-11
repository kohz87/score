import { redoDepth, redo, undo, undoDepth } from '@codemirror/commands'
import type { EditorState } from '@codemirror/state'
import type { EditorView } from '@codemirror/view'
import type { KnowledgeNoteSummary } from '@score/contract'
import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
  type MouseEvent,
  type ReactNode,
} from 'react'
import {
  activeFormats,
  alignColumn,
  applyTableOp,
  CALLOUT_TYPES,
  canApplyTableOp,
  deleteTable,
  insertLink,
  insertRule,
  insertTable,
  linkSelectionText,
  setCallout,
  setHeading,
  tableAt,
  toggleCodeBlock,
  toggleInline,
  toggleList,
  toggleQuote,
  type CalloutType,
  type InlineKind,
  type ListKind,
} from './editor-commands.ts'
import { addImageFiles } from './image-insert.ts'
import { IMAGE_TYPES } from './knowledge-images.ts'
import { baseName, linkTargetFor } from './knowledge-paths.ts'
import type { TableOp } from './table-ops.ts'

type Panel = 'heading' | 'code' | 'callout' | 'table' | 'link' | null

type Props = {
  view: EditorView | null
  state: EditorState | null
  notes: KnowledgeNoteSummary[]
  /** Problem with the last image, in words. */
  notice: string | null
  onNotice: (message: string | null) => void
  /** Bumps when a keyboard shortcut asks for the link dialog. */
  linkRequest: number
}

const isMac = () => typeof navigator !== 'undefined' && /Mac|iPhone|iPad/.test(navigator.platform)
/** `Mod-Shift-x` -> `Ctrl+Shift+X` (⌘ on a Mac). */
export function shortcutLabel(keys: string): string {
  return keys
    .split('-')
    .map((part) =>
      part === 'Mod'
        ? isMac()
          ? '⌘'
          : 'Ctrl'
        : part.length === 1
          ? part.toUpperCase()
          : part === 'Alt' && isMac()
            ? '⌥'
            : part,
    )
    .join('+')
}

const svg = (children: ReactNode) => (
  <svg
    viewBox="0 0 20 20"
    width="18"
    height="18"
    fill="none"
    stroke="currentColor"
    strokeWidth="1.6"
    strokeLinecap="round"
    strokeLinejoin="round"
    aria-hidden="true"
    focusable="false"
  >
    {children}
  </svg>
)
const ICONS = {
  undo: svg(
    <>
      <path d="M7 4 3.5 7.5 7 11" />
      <path d="M4 7.5h8a4 4 0 0 1 0 8H8" />
    </>,
  ),
  redo: svg(
    <>
      <path d="M13 4l3.5 3.5L13 11" />
      <path d="M16 7.5H8a4 4 0 0 0 0 8h4" />
    </>,
  ),
  heading: svg(
    <>
      <path d="M4 4v12M12 4v12M4 10h8" />
      <path d="M15 8l2-1v6" />
    </>,
  ),
  bold: svg(<path d="M6 4h5a3 3 0 0 1 0 6H6zM6 10h6a3 3 0 0 1 0 6H6z" />),
  italic: svg(<path d="M8 4h7M5 16h7M11.5 4l-3 12" />),
  strike: svg(
    <>
      <path d="M3 10h14" />
      <path d="M13.5 6.5C13 4.8 11.7 4 10 4S6.5 5 6.5 6.6c0 1.1.7 1.8 2 2.2M6.5 13.4c.5 1.8 1.8 2.6 3.5 2.6s3.5-1 3.5-2.6c0-.8-.4-1.4-1.1-1.8" />
    </>,
  ),
  code: svg(<path d="M7 6 3 10l4 4M13 6l4 4-4 4" />),
  bullet: svg(
    <>
      <circle cx="4.5" cy="5.5" r="1" />
      <circle cx="4.5" cy="10" r="1" />
      <circle cx="4.5" cy="14.5" r="1" />
      <path d="M8 5.5h9M8 10h9M8 14.5h9" />
    </>,
  ),
  numbered: svg(
    <>
      <path d="M8 5.5h9M8 10h9M8 14.5h9" />
      <path d="M3.5 4.5 5 4v3M3.5 12.5c0-1 1.8-1 1.8 0S3.5 13.5 3.5 14.5h2" />
    </>,
  ),
  task: svg(
    <>
      <rect x="3" y="4" width="5" height="5" rx="1" />
      <path d="m4 6.5 1 1 2-2.5M3 14h5M11 6.5h6M11 14h6" />
    </>,
  ),
  quote: svg(<path d="M4 7h4v4H5.5c0 1.5.8 2.2 2.5 2.5M12 7h4v4h-2.5c0 1.5.8 2.2 2.5 2.5" />),
  link: svg(
    <>
      <path d="M8.5 11.5a3 3 0 0 0 4.2 0l2.6-2.6a3 3 0 0 0-4.2-4.2l-.9.9" />
      <path d="M11.5 8.5a3 3 0 0 0-4.2 0L4.7 11.1a3 3 0 0 0 4.2 4.2l.9-.9" />
    </>,
  ),
  codeblock: svg(
    <>
      <rect x="3" y="4" width="14" height="12" rx="2" />
      <path d="m8 8.5-1.5 1.5L8 11.5M12 8.5l1.5 1.5-1.5 1.5" />
    </>,
  ),
  callout: svg(
    <>
      <rect x="3" y="4" width="14" height="12" rx="2" />
      <path d="M10 8v3M10 13v.01" />
    </>,
  ),
  rule: svg(<path d="M3 10h14" />),
  table: svg(
    <>
      <rect x="3" y="4" width="14" height="12" rx="2" />
      <path d="M3 8.5h14M3 12.5h14M8 4v12" />
    </>,
  ),
  image: svg(
    <>
      <rect x="3" y="4" width="14" height="12" rx="2" />
      <circle cx="7.5" cy="8.5" r="1.3" />
      <path d="m4 14 4-3.5 3 2.5 2-1.5 3 2.5" />
    </>,
  ),
}

type ToolProps = {
  id: string
  label: string
  shortcut?: string
  icon: ReactNode
  text?: string
  pressed?: boolean
  disabled?: boolean
  expanded?: boolean
  controls?: string
  onRun: (event: MouseEvent<HTMLButtonElement>) => void
}

function Tool({
  id,
  label,
  shortcut,
  icon,
  text,
  pressed,
  disabled,
  expanded,
  controls,
  onRun,
}: ToolProps) {
  const keys = shortcut ? shortcutLabel(shortcut) : null
  return (
    <button
      type="button"
      className="kn-tb-btn"
      data-tool={id}
      title={keys ? `${label} (${keys})` : label}
      aria-label={label}
      aria-keyshortcuts={shortcut?.replace('Mod', 'Control')}
      aria-pressed={pressed}
      aria-expanded={expanded}
      aria-controls={expanded ? controls : undefined}
      disabled={disabled}
      // Keep the caret and selection in the editor: the click is a command, not a focus change.
      onMouseDown={(event) => event.preventDefault()}
      onClick={onRun}
    >
      {icon}
      {text && <span className="kn-tb-text">{text}</span>}
    </button>
  )
}

function Strip({
  label,
  className,
  children,
}: {
  label: string
  className?: string
  children: ReactNode
}) {
  const ref = useRef<HTMLDivElement>(null)
  // One tab stop for the whole strip; arrow keys move between its buttons.
  const [rover, setRover] = useState(0)
  const buttons = () =>
    Array.from(ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])
  useEffect(() => {
    const list = buttons()
    list.forEach(
      (button, index) => (button.tabIndex = index === Math.min(rover, list.length - 1) ? 0 : -1),
    )
  })
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    const list = buttons()
    const at = list.indexOf(document.activeElement as HTMLButtonElement)
    if (at === -1) return
    let next: number
    if (event.key === 'ArrowRight') next = (at + 1) % list.length
    else if (event.key === 'ArrowLeft') next = (at - 1 + list.length) % list.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = list.length - 1
    else return
    event.preventDefault()
    setRover(next)
    list[next]!.focus()
  }
  return (
    <div
      ref={ref}
      role="toolbar"
      aria-label={label}
      className={`kn-tb-strip${className ? ` ${className}` : ''}`}
      onKeyDown={onKeyDown}
      onFocus={(event) => {
        const at = buttons().indexOf(event.target as unknown as HTMLButtonElement)
        if (at !== -1) setRover(at)
      }}
    >
      {children}
    </div>
  )
}

const LANGUAGES: Array<[label: string, value: string]> = [
  ['Plain text', ''],
  ['TypeScript', 'ts'],
  ['JavaScript', 'js'],
  ['Python', 'python'],
  ['Shell', 'sh'],
  ['JSON', 'json'],
  ['SQL', 'sql'],
  ['HTML', 'html'],
  ['CSS', 'css'],
  ['Markdown', 'markdown'],
]

export function EditorToolbar({ view, state, notes, notice, onNotice, linkRequest }: Props) {
  const [panel, setPanel] = useState<Panel>(null)
  const files = useRef<HTMLInputElement>(null)
  const opener = useRef<HTMLElement | null>(null)
  const active = useMemo(() => (state ? activeFormats(state) : null), [state])
  const table = useMemo(() => (state ? tableAt(state) : null), [state])
  const ready = view !== null && state !== null

  // The Mod-Alt-k shortcut asks for the link dialog (state adjusted while rendering, not in an effect).
  const [seenRequest, setSeenRequest] = useState(linkRequest)
  if (linkRequest !== seenRequest) {
    setSeenRequest(linkRequest)
    if (linkRequest > 0) setPanel('link')
  }

  const close = (restoreFocus = false) => {
    setPanel(null)
    if (restoreFocus) opener.current?.focus()
  }
  const toggle = (name: Exclude<Panel, null>, event?: { currentTarget: EventTarget }) => {
    opener.current = (event?.currentTarget as HTMLElement | undefined) ?? null
    setPanel((current) => (current === name ? null : name))
  }
  const run = (action: (editor: EditorView) => unknown) => {
    if (!view) return
    action(view)
    setPanel(null)
  }
  const inline = (kind: InlineKind) => run((editor) => toggleInline(editor, kind))
  const list = (kind: ListKind) => run((editor) => toggleList(editor, kind))
  const tableOp = (op: TableOp) => run((editor) => applyTableOp(editor, op))
  const can = (op: TableOp) => (state ? canApplyTableOp(state, op) : false)

  return (
    <div
      className="kn-toolbar"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && panel) {
          event.stopPropagation()
          close(true)
        }
      }}
    >
      <Strip label="Formatting">
        <Tool
          id={'undo'}
          label={'Undo'}
          icon={ICONS.undo}
          onRun={() => run((v) => undo(v))}
          shortcut={'Mod-z'}
          disabled={!ready || !state || undoDepth(state) === 0}
        />
        <Tool
          id={'redo'}
          label={'Redo'}
          icon={ICONS.redo}
          onRun={() => run((v) => redo(v))}
          shortcut={'Mod-Shift-z'}
          disabled={!ready || !state || redoDepth(state) === 0}
        />
        <span className="kn-tb-sep" aria-hidden="true" />
        <Tool
          id={'heading'}
          label={'Heading'}
          icon={ICONS.heading}
          onRun={(event) => toggle('heading', event)}
          pressed={(active?.heading ?? 0) > 0 ? true : undefined}
          expanded={panel === 'heading'}
          controls={'kn-tb-panel'}
          text={active && active.heading > 0 ? `H${Math.min(active.heading, 3)}` : undefined}
          disabled={!ready}
        />
        <Tool
          id={'bold'}
          label={'Bold'}
          icon={ICONS.bold}
          onRun={() => inline('bold')}
          shortcut={'Mod-b'}
          pressed={active?.bold ?? false}
          disabled={!ready}
        />
        <Tool
          id={'italic'}
          label={'Italic'}
          icon={ICONS.italic}
          onRun={() => inline('italic')}
          shortcut={'Mod-i'}
          pressed={active?.italic ?? false}
          disabled={!ready}
        />
        <Tool
          id={'strike'}
          label={'Strikethrough'}
          icon={ICONS.strike}
          onRun={() => inline('strike')}
          shortcut={'Mod-Shift-x'}
          pressed={active?.strike ?? false}
          disabled={!ready}
        />
        <Tool
          id={'code'}
          label={'Inline code'}
          icon={ICONS.code}
          onRun={() => inline('code')}
          shortcut={'Mod-e'}
          pressed={active?.code ?? false}
          disabled={!ready}
        />
        <span className="kn-tb-sep" aria-hidden="true" />
        <Tool
          id={'bullet'}
          label={'Bulleted list'}
          icon={ICONS.bullet}
          onRun={() => list('bullet')}
          shortcut={'Mod-Shift-8'}
          pressed={active?.bullet ?? false}
          disabled={!ready}
        />
        <Tool
          id={'numbered'}
          label={'Numbered list'}
          icon={ICONS.numbered}
          onRun={() => list('numbered')}
          shortcut={'Mod-Shift-7'}
          pressed={active?.numbered ?? false}
          disabled={!ready}
        />
        <Tool
          id={'task'}
          label={'Checklist'}
          icon={ICONS.task}
          onRun={() => list('task')}
          shortcut={'Mod-Shift-9'}
          pressed={active?.task ?? false}
          disabled={!ready}
        />
        <Tool
          id={'quote'}
          label={'Quote'}
          icon={ICONS.quote}
          onRun={() => run((v) => toggleQuote(v))}
          pressed={active?.quote ?? false}
          disabled={!ready}
        />
        <span className="kn-tb-sep" aria-hidden="true" />
        <Tool
          id={'link'}
          label={'Link'}
          icon={ICONS.link}
          onRun={(event) => toggle('link', event)}
          shortcut={'Mod-Alt-k'}
          pressed={active?.link ?? false}
          expanded={panel === 'link'}
          controls={'kn-tb-panel'}
          disabled={!ready}
        />
        <Tool
          id={'codeblock'}
          label={'Code block'}
          icon={ICONS.codeblock}
          onRun={(event) => toggle('code', event)}
          pressed={active?.codeBlock ?? false}
          expanded={panel === 'code'}
          controls={'kn-tb-panel'}
          disabled={!ready}
        />
        <Tool
          id={'callout'}
          label={'Callout'}
          icon={ICONS.callout}
          onRun={(event) => toggle('callout', event)}
          pressed={active?.callout ?? false}
          expanded={panel === 'callout'}
          controls={'kn-tb-panel'}
          disabled={!ready}
        />
        <Tool
          id={'rule'}
          label={'Horizontal rule'}
          icon={ICONS.rule}
          onRun={() => run((v) => insertRule(v))}
          disabled={!ready}
        />
        <Tool
          id={'table'}
          label={'Table'}
          icon={ICONS.table}
          onRun={(event) => toggle('table', event)}
          pressed={active?.table ?? false}
          expanded={panel === 'table'}
          controls={'kn-tb-panel'}
          disabled={!ready}
        />
        <Tool
          id={'image'}
          label={'Image'}
          icon={ICONS.image}
          onRun={() => files.current?.click()}
          disabled={!ready}
        />
      </Strip>
      <input
        ref={files}
        type="file"
        className="kn-sr"
        tabIndex={-1}
        aria-hidden="true"
        accept={IMAGE_TYPES.join(',')}
        multiple
        data-testid="image-input"
        onChange={(event) => {
          const picked = Array.from(event.currentTarget.files ?? [])
          event.currentTarget.value = ''
          if (view && picked.length > 0) void addImageFiles(view, picked, onNotice)
        }}
      />

      {panel && (
        <div id="kn-tb-panel" className="kn-tb-panel">
          {panel === 'heading' && (
            <div role="group" aria-label="Heading level" className="kn-tb-choices">
              {([1, 2, 3] as const).map((level) => (
                <button
                  key={level}
                  type="button"
                  aria-pressed={active?.heading === level}
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => run((v) => setHeading(v, level))}
                >
                  Heading {level}
                </button>
              ))}
              <button
                type="button"
                aria-pressed={active?.heading === 0}
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => run((v) => setHeading(v, 0))}
              >
                Paragraph
              </button>
            </div>
          )}
          {panel === 'code' && (
            <CodeLanguage
              onPick={(language) => run((v) => toggleCodeBlock(v, language))}
              inBlock={active?.codeBlock ?? false}
            />
          )}
          {panel === 'callout' && (
            <div role="group" aria-label="Callout type" className="kn-tb-choices">
              {CALLOUT_TYPES.map((type: CalloutType) => (
                <button
                  key={type}
                  type="button"
                  onMouseDown={(event) => event.preventDefault()}
                  onClick={() => run((v) => setCallout(v, type))}
                >
                  {type[0]!.toUpperCase() + type.slice(1)}
                </button>
              ))}
            </div>
          )}
          {panel === 'table' && (
            <TablePicker onPick={(columns, rows) => run((v) => insertTable(v, columns, rows))} />
          )}
          {panel === 'link' && view && state && (
            <LinkForm
              view={view}
              state={state}
              notes={notes}
              onDone={() => close(false)}
              onCancel={() => close(true)}
            />
          )}
        </div>
      )}

      {table && (
        <Strip label="Table" className="kn-tb-table">
          <span className="kn-tb-label" aria-hidden="true">
            Table
          </span>
          <Tool
            id={'row-above'}
            label={'Add row above'}
            icon={null}
            onRun={() => tableOp({ kind: 'row', where: 'above' })}
            text={'+ Row above'}
            disabled={!ready || !can({ kind: 'row', where: 'above' })}
          />
          <Tool
            id={'row-below'}
            label={'Add row below'}
            icon={null}
            onRun={() => tableOp({ kind: 'row', where: 'below' })}
            text={'+ Row below'}
            disabled={!ready || !can({ kind: 'row', where: 'below' })}
          />
          <Tool
            id={'row-delete'}
            label={'Delete row'}
            icon={null}
            onRun={() => tableOp({ kind: 'delete-row' })}
            text={'Delete row'}
            disabled={!ready || !can({ kind: 'delete-row' })}
          />
          <span className="kn-tb-sep" aria-hidden="true" />
          <Tool
            id={'col-left'}
            label={'Add column left'}
            icon={null}
            onRun={() => tableOp({ kind: 'column', where: 'left' })}
            text={'+ Col left'}
            disabled={!ready}
          />
          <Tool
            id={'col-right'}
            label={'Add column right'}
            icon={null}
            onRun={() => tableOp({ kind: 'column', where: 'right' })}
            text={'+ Col right'}
            disabled={!ready}
          />
          <Tool
            id={'col-delete'}
            label={'Delete column'}
            icon={null}
            onRun={() => tableOp({ kind: 'delete-column' })}
            text={'Delete column'}
            disabled={!ready || !can({ kind: 'delete-column' })}
          />
          <Tool
            id={'col-move-left'}
            label={'Move column left'}
            icon={null}
            onRun={() => tableOp({ kind: 'move-column', direction: 'left' })}
            text={'← Move'}
            disabled={!ready || !can({ kind: 'move-column', direction: 'left' })}
          />
          <Tool
            id={'col-move-right'}
            label={'Move column right'}
            icon={null}
            onRun={() => tableOp({ kind: 'move-column', direction: 'right' })}
            text={'Move →'}
            disabled={!ready || !can({ kind: 'move-column', direction: 'right' })}
          />
          <span className="kn-tb-sep" aria-hidden="true" />
          <Tool
            id={'align-left'}
            label={'Align column left'}
            icon={null}
            onRun={() => run((v) => alignColumn(v, 'left'))}
            text={'Left'}
            disabled={!ready}
          />
          <Tool
            id={'align-center'}
            label={'Align column center'}
            icon={null}
            onRun={() => run((v) => alignColumn(v, 'center'))}
            text={'Center'}
            disabled={!ready}
          />
          <Tool
            id={'align-right'}
            label={'Align column right'}
            icon={null}
            onRun={() => run((v) => alignColumn(v, 'right'))}
            text={'Right'}
            disabled={!ready}
          />
          <span className="kn-tb-sep" aria-hidden="true" />
          <Tool
            id={'table-delete'}
            label={'Delete table'}
            icon={null}
            onRun={() => run((v) => deleteTable(v))}
            text={'Delete table'}
            disabled={!ready}
          />
        </Strip>
      )}

      {notice && (
        <p role="alert" className="kn-tb-notice">
          {notice}{' '}
          <button type="button" className="kn-link-button" onClick={() => onNotice(null)}>
            Dismiss
          </button>
        </p>
      )}
    </div>
  )
}

function CodeLanguage({
  onPick,
  inBlock,
}: {
  onPick: (language: string) => void
  inBlock: boolean
}) {
  const [other, setOther] = useState('')
  return (
    <div className="kn-tb-code">
      <div role="group" aria-label="Code block language" className="kn-tb-choices">
        {LANGUAGES.map(([label, value]) => (
          <button
            key={label}
            type="button"
            onMouseDown={(event) => event.preventDefault()}
            onClick={() => onPick(value)}
          >
            {label}
          </button>
        ))}
      </div>
      <form
        className="kn-tb-inline"
        onSubmit={(event) => {
          event.preventDefault()
          const language = other.trim().replace(/[^A-Za-z0-9_+#.-]/g, '')
          onPick(language)
        }}
      >
        <label>
          Other language
          <input value={other} maxLength={30} onChange={(event) => setOther(event.target.value)} />
        </label>
        <button type="submit">Insert</button>
      </form>
      {inBlock && (
        <p className="kn-muted">
          The caret is in a code block: choosing a language removes the block.
        </p>
      )}
    </div>
  )
}

function TablePicker({ onPick }: { onPick: (columns: number, rows: number) => void }) {
  const [hover, setHover] = useState({ columns: 0, rows: 0 })
  const grid = useRef<HTMLDivElement>(null)
  const move = (event: KeyboardEvent<HTMLButtonElement>, columns: number, rows: number) => {
    const delta: Record<string, [number, number]> = {
      ArrowRight: [1, 0],
      ArrowLeft: [-1, 0],
      ArrowDown: [0, 1],
      ArrowUp: [0, -1],
    }
    const step = delta[event.key]
    if (!step) return
    event.preventDefault()
    const nextColumns = Math.min(8, Math.max(1, columns + step[0]))
    const nextRows = Math.min(8, Math.max(1, rows + step[1]))
    grid.current
      ?.querySelector<HTMLButtonElement>(`[data-cell="${nextColumns}x${nextRows}"]`)
      ?.focus()
  }
  return (
    <div className="kn-tb-table-picker">
      <div
        ref={grid}
        role="group"
        aria-label="Table size"
        className="kn-tb-grid"
        onMouseLeave={() => setHover({ columns: 0, rows: 0 })}
      >
        {Array.from({ length: 8 }, (_, row) =>
          Array.from({ length: 8 }, (_, column) => {
            const columns = column + 1
            const rows = row + 1
            return (
              <button
                key={`${columns}x${rows}`}
                type="button"
                data-cell={`${columns}x${rows}`}
                className={columns <= hover.columns && rows <= hover.rows ? 'is-on' : undefined}
                aria-label={`${columns} columns by ${rows} rows`}
                tabIndex={columns === 1 && rows === 1 ? 0 : -1}
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setHover({ columns, rows })}
                onFocus={() => setHover({ columns, rows })}
                onKeyDown={(event) => move(event, columns, rows)}
                onClick={() => onPick(columns, rows)}
              />
            )
          }),
        )}
      </div>
      <p className="kn-tb-grid-label" aria-live="polite">
        {hover.columns > 0
          ? `${hover.columns} × ${hover.rows}`
          : 'Choose a size (the first row is the header)'}
      </p>
    </div>
  )
}

function LinkForm({
  view,
  state,
  notes,
  onDone,
  onCancel,
}: {
  view: EditorView
  state: EditorState
  notes: KnowledgeNoteSummary[]
  onDone: () => void
  onCancel: () => void
}) {
  const [text, setText] = useState(() => linkSelectionText(state))
  const [kind, setKind] = useState<'web' | 'note'>('web')
  const [value, setValue] = useState('')
  const [error, setError] = useState<string | null>(null)
  const first = useRef<HTMLInputElement>(null)
  useEffect(() => first.current?.focus(), [])
  const options = useMemo(
    () => notes.slice(0, 200).map((note) => ({ target: linkTargetFor(note, notes), note })),
    [notes],
  )
  const submit = (event: FormEvent) => {
    event.preventDefault()
    const entered = value.trim()
    if (kind === 'note') {
      const target = entered.replace(/^\[\[|\]\]$/g, '').trim()
      if (target === '') return setError('Choose or type the name of a note.')
      insertLink(view, text, { kind: 'note', target })
      return onDone()
    }
    const url = /^(https?:\/\/|mailto:)/i.test(entered)
      ? entered
      : /^[^\s/]+\.[^\s/]+/.test(entered)
        ? `https://${entered}`
        : ''
    if (url === '') return setError('Enter a web address such as https://example.com.')
    insertLink(view, text, { kind: 'web', url })
    onDone()
  }
  return (
    <form className="kn-tb-link" onSubmit={submit} aria-label="Insert link">
      <div role="radiogroup" aria-label="Link to" className="kn-tb-choices">
        {(['web', 'note'] as const).map((choice) => (
          <button
            key={choice}
            type="button"
            role="radio"
            aria-checked={kind === choice}
            onClick={() => {
              setKind(choice)
              setError(null)
            }}
          >
            {choice === 'web' ? 'Web address' : 'Another note'}
          </button>
        ))}
      </div>
      <label>
        Text
        <input value={text} maxLength={300} onChange={(event) => setText(event.target.value)} />
      </label>
      <label>
        {kind === 'web' ? 'Address' : 'Note'}
        <input
          ref={first}
          value={value}
          maxLength={1000}
          list={kind === 'note' ? 'kn-tb-notes' : undefined}
          placeholder={kind === 'web' ? 'https://' : 'Start typing a note name'}
          aria-invalid={error ? true : undefined}
          aria-describedby={error ? 'kn-tb-link-error' : undefined}
          onChange={(event) => {
            setValue(event.target.value)
            setError(null)
          }}
        />
      </label>
      {kind === 'note' && (
        <datalist id="kn-tb-notes">
          {options.map(({ target, note }) => (
            <option key={note.path} value={target} label={note.title || baseName(note.path)} />
          ))}
        </datalist>
      )}
      <button type="submit" className="kn-primary">
        Insert link
      </button>
      <button type="button" onClick={onCancel}>
        Cancel
      </button>
      {error && (
        <p id="kn-tb-link-error" role="alert" className="kn-tb-error">
          {error}
        </p>
      )}
    </form>
  )
}
