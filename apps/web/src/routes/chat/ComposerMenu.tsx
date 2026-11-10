import type { AgentSummary } from '@score/contract'
import { AgentGlyph } from '../../components/AgentGlyph.tsx'
import type { SlashCommand } from './composer-model.ts'

export function ComposerMenu({
  menu,
  count,
  slashItems,
  mentionItems,
  ids,
  index,
  optionId,
  select,
}: {
  menu: 'slash' | 'mention' | null
  count: number
  slashItems: SlashCommand[]
  mentionItems: AgentSummary[]
  ids: string
  index: number
  optionId: (position: number) => string
  select: (position: number) => void
}) {
  if (!menu || count === 0) return null
  // Only the selected command's note shows, so a note never sits under the other commands.
  const note = menu === 'slash' ? slashItems[index]?.note : null
  // A group's header (`/effort`'s "Effort for builder…") sits above its first item.
  const header = menu === 'slash' ? slashItems[0]?.header : null
  return (
    <div
      className="chat-menu"
      role="listbox"
      id={`${ids}-menu`}
      aria-label={menu === 'slash' ? 'Commands' : 'Agents'}
    >
      {header && (
        <div className="bold-composer-menu-header" role="presentation">
          {header}
        </div>
      )}
      {menu === 'slash'
        ? slashItems.map((item, position) => (
            <button
              key={item.key ?? item.name}
              id={optionId(position)}
              type="button"
              role="option"
              tabIndex={-1}
              aria-selected={position === index}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => select(position)}
            >
              <span className="chat-menu-command">{item.insert ?? `/${item.name}`}</span>
              <span className="chat-menu-detail" title={item.description}>
                {item.description}
              </span>
            </button>
          ))
        : mentionItems.map((agent, position) => (
            <button
              key={agent.id}
              id={optionId(position)}
              type="button"
              role="option"
              tabIndex={-1}
              aria-selected={position === index}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => select(position)}
            >
              <AgentGlyph agent={agent} size="xs" bare decorative />
              <span className="chat-menu-command">@{agent.id}</span>
              <span className="chat-menu-detail" title={agent.role ?? undefined}>
                {agent.role}
              </span>
            </button>
          ))}
      {note && <div className="chat-menu-note">{note}</div>}
    </div>
  )
}
