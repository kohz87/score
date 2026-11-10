import type { ChatModel } from '@score/contract'
import { onChoiceMenuKeyDown } from '../choice-menu.ts'
import { PALETTE_MODELS } from './model-model.ts'
import { ownModelText } from './model-menu.ts'
import type { ModelChoices } from './use-model-choices.ts'

/**
 * The Model part of the tag's menu (mock-up 27-model-main): the agent's aliases and models, then "Back to its own". The
 * same list as the `/model` palette, as radio items so the keyboard works as it does for the Effort part.
 */
export function ModelPartPicker({
  name,
  choices,
  current,
  onChoose,
}: {
  name: string
  choices: ModelChoices
  current: ChatModel | null
  /** A model or alias, or null for back to the agent's own. */
  onChoose: (value: string | null) => void
}) {
  const shown = choices.models.slice(0, PALETTE_MODELS)
  const more = choices.models.length - shown.length
  const rows = [...choices.aliases, ...shown]
  const checked = (value: string) =>
    current !== null && (current.label === value || current.model === value)
  return (
    <div
      className="bold-effort-menu"
      role="menu"
      aria-label={`Model for ${name}`}
      onKeyDown={(event) => onChoiceMenuKeyDown(event, event.currentTarget)}
    >
      <div className="bold-effort-menu-head">
        Model for <b>{name}</b> in this chat · its own is <b>{ownModelText(choices)}</b>
      </div>
      {rows.map((row) => (
        <button
          key={`${row.value}:${row.detail}`}
          type="button"
          role="menuitemradio"
          aria-checked={checked(row.value)}
          onClick={() => onChoose(row.value)}
        >
          <code>/model {row.value}</code>
          <small>{row.detail}</small>
        </button>
      ))}
      {more > 0 && (
        <div className="bold-composer-menu-more">+ {more} more: type /model to narrow</div>
      )}
      <button
        type="button"
        role="menuitemradio"
        aria-checked={current === null}
        onClick={() => onChoose(null)}
      >
        <code>/model default</code>
        <small>
          Back to {name}’s own ({ownModelText(choices)})
        </small>
      </button>
    </div>
  )
}
