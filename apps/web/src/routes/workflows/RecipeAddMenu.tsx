import type { AgentSummary, WorkflowNodeKind } from '@score/contract'
import { useRef, useState, type KeyboardEvent } from 'react'
import { AgentGlyph } from '../../components/AgentGlyph.tsx'
import type { InsertAt, InsertStep } from './recipe-layers-types.ts'
import { KIND_LABEL } from './workflow-model.ts'

export function AddMenu({
  label,
  text,
  at,
  agents,
  onInsert,
  withEnd = false,
}: {
  label: string
  /** A visible word on the trigger (the settings panel); without it the trigger is a round +. */
  text?: string
  at: InsertAt
  agents: AgentSummary[]
  onInsert: InsertStep
  withEnd?: boolean
}) {
  const [open, setOpen] = useState(false)
  const trigger = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const hermes = agents.filter((agent) => !agent.runtime || agent.runtime === 'hermes')
  const items = () =>
    Array.from(menu.current?.querySelectorAll<HTMLButtonElement>('[role="menuitem"]') ?? [])
  const pick = (kind: WorkflowNodeKind, agent?: AgentSummary) => {
    setOpen(false)
    onInsert(at, kind, agent?.id ?? '', agent?.name ?? '')
  }
  const close = () => {
    setOpen(false)
    trigger.current?.focus()
  }
  // A menu: the first item takes focus on open, the arrows, Home and End move between items, Escape returns to the +.
  function onMenuKey(event: KeyboardEvent<HTMLDivElement>) {
    const list = items()
    const at = list.indexOf(document.activeElement as HTMLButtonElement)
    const go = (index: number) => {
      event.preventDefault()
      list[(index + list.length) % list.length]?.focus()
    }
    if (event.key === 'ArrowDown') go(at + 1)
    else if (event.key === 'ArrowUp') go(at < 0 ? -1 : at - 1)
    else if (event.key === 'Home') go(0)
    else if (event.key === 'End') go(-1)
    else if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      close()
    } else if (event.key === 'Tab') setOpen(false)
  }
  const kinds: [WorkflowNodeKind, string][] = [
    ['gate', 'An approval: you decide'],
    ['branch', 'A branch: pick a path'],
    ['join', 'A join: wait for every path'],
    ...(withEnd ? ([['end', 'Done: finish the run']] as [WorkflowNodeKind, string][]) : []),
  ]
  return (
    <span className="rl-add">
      <button
        ref={trigger}
        type="button"
        className={text ? 'rl-plus rl-plus--text' : 'rl-plus'}
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          const next = !open
          setOpen(next)
          if (next) requestAnimationFrame(() => items()[0]?.focus())
        }}
        onKeyDown={(event) => {
          if (event.key === 'Escape' && open) {
            event.stopPropagation()
            setOpen(false)
          } else if (event.key === 'ArrowDown' && !open) {
            event.preventDefault()
            setOpen(true)
            requestAnimationFrame(() => items()[0]?.focus())
          }
        }}
      >
        {text ? text : <span aria-hidden="true">+</span>}
      </button>
      {open && (
        <div ref={menu} className="rl-menu" role="menu" aria-label={label} onKeyDown={onMenuKey}>
          {hermes.map((agent) => (
            <button
              key={agent.id}
              type="button"
              role="menuitem"
              tabIndex={-1}
              aria-label={`Add an agent step for ${agent.name}`}
              onClick={() => pick('agent', agent)}
            >
              <AgentGlyph agent={agent} size="xs" decorative />
              <span>{agent.name}</span>
            </button>
          ))}
          {kinds.map(([kind, text]) => (
            <button
              key={kind}
              type="button"
              role="menuitem"
              tabIndex={-1}
              aria-label={`Add ${kind === 'end' ? 'an' : 'a'} ${KIND_LABEL[kind].toLowerCase()}`}
              onClick={() => pick(kind)}
            >
              <span>{text}</span>
            </button>
          ))}
        </div>
      )}
    </span>
  )
}
