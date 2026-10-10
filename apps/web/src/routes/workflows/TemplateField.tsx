import { useId, useRef, useState, type KeyboardEvent } from 'react'
import type { Draft } from './workflow-model.ts'
import {
  applyOption,
  openReference,
  suggest,
  type OpenReference,
  type TemplateOption,
} from './workflow-template.ts'

/**
 * A text area for an instruction or a question with `{{ … }}` autocomplete: typing `{{` lists the start inputs and the
 * results of earlier steps (the only things a step may read). Arrow keys choose, Enter or Tab inserts, Escape closes.
 */
export function TemplateField({
  label,
  value,
  onChange,
  draft,
  nodeId,
  rows = 6,
  invalid = false,
  describedBy,
}: {
  label: string
  value: string
  onChange: (value: string) => void
  draft: Draft
  nodeId: string
  rows?: number
  invalid?: boolean
  describedBy?: string
}) {
  const id = useId()
  const listId = `${id}-list`
  const area = useRef<HTMLTextAreaElement>(null)
  const [open, setOpen] = useState<OpenReference | null>(null)
  const [active, setActive] = useState(0)
  const options: TemplateOption[] = open ? suggest(draft, nodeId, open.query) : []
  const showing = open !== null && options.length > 0

  function look(next: string, caret: number) {
    setOpen(openReference(next, caret))
    setActive(0)
  }

  function pick(option: TemplateOption) {
    if (!open) return
    const applied = applyOption(value, open, option)
    onChange(applied.text)
    setOpen(null)
    // The caret goes after the inserted reference once React has written the new text.
    requestAnimationFrame(() => {
      area.current?.focus()
      area.current?.setSelectionRange(applied.caret, applied.caret)
    })
  }

  function onKeyDown(event: KeyboardEvent<HTMLTextAreaElement>) {
    if (!showing) return
    if (event.key === 'ArrowDown') {
      event.preventDefault()
      setActive((n) => (n + 1) % options.length)
    } else if (event.key === 'ArrowUp') {
      event.preventDefault()
      setActive((n) => (n - 1 + options.length) % options.length)
    } else if (event.key === 'Enter' || event.key === 'Tab') {
      event.preventDefault()
      pick(options[active]!)
    } else if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      setOpen(null)
    }
  }

  function insertBraces() {
    const el = area.current
    if (!el) return
    const at = el.selectionStart
    const next = `${value.slice(0, at)}{{${value.slice(el.selectionEnd)}`
    onChange(next)
    requestAnimationFrame(() => {
      el.focus()
      el.setSelectionRange(at + 2, at + 2)
      look(next, at + 2)
    })
  }

  return (
    <div className="orch-field wf-template">
      <label htmlFor={id}>
        <span>{label}</span>
      </label>
      <textarea
        id={id}
        ref={area}
        rows={rows}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={showing}
        aria-controls={showing ? listId : undefined}
        aria-activedescendant={showing ? `${id}-opt-${active}` : undefined}
        aria-invalid={invalid || undefined}
        aria-describedby={describedBy}
        value={value}
        spellCheck
        onChange={(event) => {
          onChange(event.target.value)
          look(event.target.value, event.target.selectionStart)
        }}
        onKeyDown={onKeyDown}
        onKeyUp={(event) => {
          if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key))
            look(value, event.currentTarget.selectionStart)
        }}
        onClick={(event) => look(value, event.currentTarget.selectionStart)}
        onBlur={() => setOpen(null)}
      />
      <div className="wf-template__bar">
        <button type="button" className="wf-link" onClick={insertBraces}>
          Insert a value from an earlier step or an input
        </button>
        <span className="orch-muted">
          Type <code>{'{{'}</code> to pick one.
        </span>
      </div>
      {showing && (
        <ul id={listId} role="listbox" aria-label={`Values for ${label}`} className="wf-suggest">
          {options.map((option, index) => (
            <li
              key={option.insert}
              id={`${id}-opt-${index}`}
              role="option"
              aria-selected={index === active}
              className={index === active ? 'wf-suggest__on' : undefined}
              // mousedown, not click: the text area's blur would close the list first.
              onMouseDown={(event) => {
                event.preventDefault()
                pick(option)
              }}
            >
              <code>{option.label}</code>
              <small>{option.detail}</small>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
