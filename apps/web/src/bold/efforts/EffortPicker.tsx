import { EFFORT_HINTS, ownEffortLabel, unlistedLevelsNote } from './effort-model.ts'

/**
 * The choices for one agent's effort in one chat (mock-up 25-effort-group): its levels, then "Back to its own". The menu
 * is a `role="menu"` of radio items; the tag's wrapper owns the keyboard, so it is one list with the Model part. `levels` is null when the read
 * failed: then only "Back to its own" is offered, and the note says the levels can't be listed.
 */
export function EffortPicker({
  name,
  levels,
  own,
  current,
  onChoose,
}: {
  name: string
  levels: readonly string[] | null
  /** undefined when the agent's own setting could not be read ("unknown"). */
  own: string | null | undefined
  current: string | null
  /** A level, or null for back to the agent's own. */
  onChoose: (level: string | null) => void
}) {
  return (
    <div className="bold-effort-menu" role="menu" aria-label={`Effort for ${name}`}>
      <div className="bold-effort-menu-head">
        Effort for <b>{name}</b> in this chat · its own setting is <b>{ownEffortLabel(own)}</b>
      </div>
      {levels?.map((level) => (
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
        {levels ? (
          <>Only the levels {name}’s model accepts are listed. Other chats keep its own setting.</>
        ) : (
          unlistedLevelsNote(name)
        )}
      </div>
    </div>
  )
}
