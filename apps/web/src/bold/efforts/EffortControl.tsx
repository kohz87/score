import { useId, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { useChoiceMenu } from '../choice-menu.ts'
import { agentDisplayName } from '../bold-agents.ts'
import type { AgentSummary } from '@score/contract'
import { EffortPicker } from './EffortPicker.tsx'
import { effortButtonLabel, isAmberEffort } from './effort-model.ts'
import { useAgentEfforts } from './effort-queries.ts'
import './efforts.css'

/** Runs `/effort <args>` for an agent in this chat, from `useRunEffort` (its note and Undo come with it). */
export type RunEffort = (agent: AgentSummary, args: string) => Promise<void>

/**
 * A button that opens the choices for one agent's effort in this chat. Shared by the context bar and the Members tags, so
 * both change an effort the same way: through the chat's `/effort` command.
 */
export function EffortChoice({
  agent,
  current,
  runEffort,
  className,
  label,
  children,
  showWhenOwn = false,
  placement = 'up',
  align = 'start',
}: {
  agent: AgentSummary
  current: string | null
  runEffort: RunEffort
  className: string
  label: string
  children: ReactNode
  /** Shown for an agent on its own too (Chat info's "Change effort"), not only once this chat sets one. */
  showWhenOwn?: boolean
  /** Where the choices open: up over the context bar, down in the narrow Chat info panels. */
  placement?: 'up' | 'down'
  /** Which edge of the button the choices line up with: a tag at the right of a panel opens leftward. */
  align?: 'start' | 'end'
}) {
  const [open, setOpen] = useState(false)
  const [failed, setFailed] = useState(false)
  const [saving, setSaving] = useState(false)
  const button = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const menuId = useId()
  const levels = useAgentEfforts(agent.id)
  const efforts = levels.data
  // The choices are ready once the agent's efforts have answered, or the read failed (the menu then says so).
  const ready = Boolean(efforts) || levels.isError
  useChoiceMenu({ open, setOpen, button, menu, ready })
  if (current === null && !showWhenOwn) return null

  function choose(level: string | null) {
    button.current?.focus()
    setOpen(false)
    setFailed(false)
    setSaving(true)
    runEffort(agent, level ?? 'default')
      .catch(() => setFailed(true))
      .finally(() => setSaving(false))
  }

  const name = agentDisplayName(agent)
  return (
    <span
      className={`bold-effort-choice${placement === 'down' ? ' bold-effort-choice--down' : ''}${align === 'end' ? ' bold-effort-choice--end' : ''}`}
    >
      <button
        ref={button}
        type="button"
        className={`${className}${isAmberEffort(current) ? ' bold-effort--max' : ''}`}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={open ? menuId : undefined}
        aria-label={label}
        aria-disabled={saving || undefined}
        onClick={() => {
          if (!saving) setOpen((value) => !value)
        }}
      >
        {children}
      </button>
      {open && ready && (
        <EffortPicker
          id={menuId}
          menuRef={menu}
          name={name}
          levels={efforts?.levels ?? null}
          own={efforts ? efforts.own : undefined}
          current={current}
          onChoose={choose}
        />
      )}
      {failed && (
        <span className="bold-effort-error" role="alert">
          Couldn’t change the effort. Try again.
        </span>
      )}
    </span>
  )
}

/** The context bar's "Effort max" beside the model: shown only when this chat sets an effort for the agent. */
export function EffortControl({
  agent,
  current,
  runEffort,
}: {
  agent: AgentSummary
  current: string | null
  runEffort: RunEffort
}) {
  if (current === null) return null
  return (
    <EffortChoice
      agent={agent}
      current={current}
      runEffort={runEffort}
      className="bold-effort-button"
      label={`Effort in this chat: ${current}. Change`}
    >
      {effortButtonLabel(current)}
    </EffortChoice>
  )
}

/** Chat info › Members: the tag on an agent set differently in this chat. An agent on its own has none. */
export function EffortTag({
  agent,
  current,
  runEffort,
}: {
  agent: AgentSummary
  current: string | null
  runEffort: RunEffort
}) {
  if (current === null) return null
  const name = agentDisplayName(agent)
  return (
    <EffortChoice
      agent={agent}
      current={current}
      runEffort={runEffort}
      className="bold-effort-tag"
      placement="down"
      align="end"
      label={`${name}’s effort in this chat: ${current}. Change`}
    >
      {effortButtonLabel(current)}
    </EffortChoice>
  )
}
