import type { AgentEfforts } from '@score/contract'
import type { SlashCommand } from '../../routes/chat/composer-model.ts'
import { EFFORT_HINTS, ownEffortLabel, unlistedLevelsNote } from './effort-model.ts'

/**
 * The `/effort` palette for one agent (mock-up 25-effort-group): only the levels its model takes, then "Back to its own".
 * The header is the first item's, and the note sits under the list. Empty until the agent's efforts have loaded. When the
 * read failed (`failed`), it offers only "Back to its own", with the note that says the levels can't be listed.
 */
export function effortMenuItems(
  efforts: AgentEfforts | undefined,
  name: string,
  failed = false,
): SlashCommand[] {
  if (!efforts && failed) {
    return [
      {
        name: 'effort',
        usage: '/effort default',
        insert: '/effort default',
        key: 'effort-default',
        description: `Back to ${name}’s own (unknown)`,
        note: unlistedLevelsNote(name),
        header: `Effort for ${name} in this chat · its own setting is unknown`,
      },
    ]
  }
  if (!efforts) return []
  const own = ownEffortLabel(efforts.own)
  const header = `Effort for ${name} in this chat · its own setting is ${ownEffortLabel(efforts.own)}`
  const note = `Only the levels ${name}’s model accepts are listed. Other chats keep its own setting.`
  const levels: SlashCommand[] = efforts.levels.map((level, index) => ({
    name: 'effort',
    usage: `/effort ${level}`,
    insert: `/effort ${level}`,
    key: `effort-${level}`,
    description: EFFORT_HINTS[level] ?? level,
    note,
    ...(index === 0 ? { header } : {}),
  }))
  if (levels.length === 0) return []
  return [
    ...levels,
    {
      name: 'effort',
      usage: '/effort default',
      insert: '/effort default',
      key: 'effort-default',
      description: `Back to ${name}’s own (${own})`,
      note,
    },
  ]
}
