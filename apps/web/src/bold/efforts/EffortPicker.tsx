import type { RefObject } from 'react'
import { onChoiceMenuKeyDown } from '../choice-menu.ts'
import { EFFORT_HINTS, ownEffortLabel } from './effort-model.ts'

/**
 * The choices for one agent's effort in one chat (mock-up 25-effort-group): its levels, then "Back to its own". The menu
 * is a `role="menu"` of radio items, so the keyboard works as it does for `/subagents`.
 */
export function EffortPicker({
  id,
  menuRef,
  name,
  levels,
  own,
  current,
  onChoose,
}: {
  id: string
  /** The menu's element, for the focus that opens it on the checked choice. */
  menuRef: RefObject<HTMLDivElement | null>
  name: string
  levels: readonly string[]
  own: string | null
  current: string | null
  /** A level, or null for back to the agent's own. */
  onChoose: (level: string | null) => void
}) {
  return (
    <div
      ref={menuRef}
      className="bold-effort-menu"
      id={id}
      role="menu"
      aria-label={`Effort for ${name}`}
      onKeyDown={(event) => onChoiceMenuKeyDown(event, event.currentTarget)}
    >
      <div className="bold-effort-menu-head">
        Effort for <b>{name}</b> in this chat · its own setting is <b>{ownEffortLabel(own)}</b>
      </div>
      {levels.map((level) => (
        <button
          key={level}
          type="button"
          role="menuitemradio"
          aria-checked={current === level}
          onClick={() => onChoose(level)}
        >
          <code>/effort {level}</code>
          <small>{EFFORT_HINTS[level] ?? level}</small>
        </button>
      ))}
      <button
        type="button"
        role="menuitemradio"
        aria-checked={current === null}
        onClick={() => onChoose(null)}
      >
        <code>/effort default</code>
        <small>
          Back to {name}’s own ({ownEffortLabel(own)})
        </small>
      </button>
      <div className="bold-effort-menu-note">
        Only the levels {name}’s model accepts are listed. Other chats keep its own setting.
      </div>
    </div>
  )
}
