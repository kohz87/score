import { redoDepth, redo, undo, undoDepth } from '@codemirror/commands'
import type { EditorView } from '@codemirror/view'
import { useMemo, useRef, useState } from 'react'
import {
  activeFormats,
  alignColumn,
  applyTableOp,
  CALLOUT_TYPES,
  canApplyTableOp,
  deleteTable,
  insertRule,
  insertTable,
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
import { CodeLanguage, TablePicker } from './EditorToolbarPanels.tsx'
import { ICONS } from './editor-toolbar-icons.tsx'
import { Strip, Tool } from './EditorToolbarControls.tsx'
import { LinkForm } from './EditorLinkForm.tsx'
import type { EditorToolbarProps as Props, Panel } from './editor-toolbar-types.ts'
import { addImageFiles } from './image-insert.ts'
import { IMAGE_TYPES } from './knowledge-images.ts'
import type { TableOp } from './table-ops.ts'

export { shortcutLabel } from './EditorToolbarControls.tsx'

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
            label={'Align column centre'}
            icon={null}
            onRun={() => run((v) => alignColumn(v, 'center'))}
            text={'Centre'}
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
