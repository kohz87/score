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
  return (
    <div
      className="chat-menu"
      role="listbox"
      id={`${ids}-menu`}
      aria-label={menu === 'slash' ? 'Commands' : 'Agents'}
    >
      {menu === 'slash'
        ? slashItems.map((item, position) => (
            <button
              key={item.name}
              id={optionId(position)}
              type="button"
              role="option"
              tabIndex={-1}
              aria-selected={position === index}
              onMouseDown={(event) => event.preventDefault()}
              onClick={() => select(position)}
            >
              <span className="chat-menu-command">/{item.name}</span>
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
    </div>
  )
}
