import { useId, useRef, useState } from 'react'
import type { ReactNode } from 'react'
import { onChoiceMenuKeyDown, useChoiceMenu } from '../choice-menu.ts'
import { agentDisplayName } from '../bold-agents.ts'
import { ApiError } from '../../data/api.ts'
import type { AgentSummary, ChatModel } from '@score/contract'
import { EffortPicker } from './EffortPicker.tsx'
import { useAgentEfforts } from './effort-queries.ts'
import { ChatTagText } from '../models/ChatTagText.tsx'
import { ModelPartPicker } from '../models/ModelPartPicker.tsx'
import { chatTagLabel, isAmberChat } from '../models/model-model.ts'
import { useModelChoices } from '../models/use-model-choices.ts'
import './efforts.css'
import '../models/models.css'

/** Runs `/effort <args>` for an agent in this chat, from `useRunEffort` (its note and Undo come with it). */
export type RunEffort = (agent: AgentSummary, args: string) => Promise<void>
/** Runs `/model <args>` for an agent in this chat, from `useRunModel`. */
export type RunModel = (agent: AgentSummary, args: string, provider?: string) => Promise<void>

/** What a chat sets for one agent, and the runners that change it. */
export type ChatTagState = {
  agent: AgentSummary
  /** The model this chat sets for the agent; null when it uses its own. */
  model: ChatModel | null
  /** The effort this chat sets for the agent; null when it uses its own. */
  current: string | null
  runEffort: RunEffort
  runModel: RunModel
}

/**
 * A button that opens one menu for an agent in this chat, with two parts: Model (the `/model` list) and Effort (the
 * levels), each with "Back to its own" (decision 182, mock-up 27-model-main). Shared by the context bar, the Members tags
 * and This chat, so all of them change either through the chat's own commands.
 */
export function EffortChoice({
  agent,
  model,
  current,
  runEffort,
  runModel,
  className,
  label,
  children,
  showWhenOwn = false,
  placement = 'up',
  align = 'start',
}: ChatTagState & {
  className: string
  label: string
  children: ReactNode
  /** Shown for an agent on its own too (Chat info's "Change effort"), not only once this chat sets something. */
  showWhenOwn?: boolean
  /** Where the choices open: up over the context bar, down in the narrow Chat info panels. */
  placement?: 'up' | 'down'
  /** Which edge of the button the choices line up with: a tag at the right of a panel opens leftward. */
  align?: 'start' | 'end'
}) {
  const [open, setOpen] = useState(false)
  const [failed, setFailed] = useState<{ part: 'effort' | 'model'; message: string | null } | null>(
    null,
  )
  const [saving, setSaving] = useState(false)
  const button = useRef<HTMLButtonElement>(null)
  const menu = useRef<HTMLDivElement>(null)
  const menuId = useId()
  const levels = useAgentEfforts(agent.id)
  const efforts = levels.data
  const choices = useModelChoices(agent, open ? '' : null)
  // The choices are ready once the agent's efforts and models have answered, or the efforts read failed (the menu then says so).
  const ready = (Boolean(efforts) || levels.isError) && choices.ready
  useChoiceMenu({ open, setOpen, button, menu, ready })
  if (current === null && model === null && !showWhenOwn) return null

  function choose(part: 'effort' | 'model', value: string | null, provider?: string) {
    button.current?.focus()
    setOpen(false)
    setFailed(null)
    setSaving(true)
    const run =
      part === 'effort' ? runEffort : (a: AgentSummary, v: string) => runModel(a, v, provider)
    run(agent, value ?? 'default')
      .catch((error: unknown) =>
        setFailed({ part, message: error instanceof ApiError ? error.message : null }),
      )
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
        className={`${className}${isAmberChat(model, current) ? ' bold-effort--max' : ''}`}
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
        <div
          ref={menu}
          className="bold-me-menu"
          id={menuId}
          onKeyDown={(event) => onChoiceMenuKeyDown(event, menu.current)}
        >
          <div className="bold-me-part-title">MODEL</div>
          <ModelPartPicker
            name={name}
            choices={choices}
            current={model}
            onChoose={(value, provider) => choose('model', value, provider)}
          />
          <div className="bold-me-part-title">EFFORT</div>
          <EffortPicker
            name={name}
            levels={efforts?.levels ?? null}
            own={efforts ? efforts.own : undefined}
            current={current}
            onChoose={(level) => choose('effort', level)}
          />
        </div>
      )}
      {failed && (
        <span className="bold-effort-error" role="alert">
          {failed.message ?? `Couldn’t change the ${failed.part}. Try again.`}
        </span>
      )}
    </span>
  )
}

/** The context bar's "deep · max" beside the model: shown only when this chat sets a model or an effort for the agent. */
export function EffortControl(state: ChatTagState) {
  if (state.current === null && state.model === null) return null
  return (
    <EffortChoice
      {...state}
      className="bold-effort-button"
      label={chatTagLabel(agentDisplayName(state.agent), state.model, state.current)}
    >
      <ChatTagText model={state.model} effort={state.current} />
    </EffortChoice>
  )
}

/** Chat info › Members: the tag on an agent set differently in this chat. An agent on its own has none. */
export function EffortTag(state: ChatTagState) {
  if (state.current === null && state.model === null) return null
  return (
    <EffortChoice
      {...state}
      className="bold-effort-tag"
      placement="down"
      align="end"
      label={chatTagLabel(agentDisplayName(state.agent), state.model, state.current)}
    >
      <ChatTagText model={state.model} effort={state.current} />
    </EffortChoice>
  )
}
