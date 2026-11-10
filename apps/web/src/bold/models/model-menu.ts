import type { SlashCommand } from '../../routes/chat/composer-model.ts'
import { PALETTE_MODELS } from './model-model.ts'
import type { ModelChoices } from './use-model-choices.ts'

/** The own model as the header reads it: a coding agent's names its program too ("Claude Code · sonnet"). */
export const ownModelText = (choices: ModelChoices) =>
  choices.coding
    ? `${choices.program} · ${choices.own ?? 'the program’s default'}`
    : (choices.own ?? 'unknown')

/**
 * The `/model` palette for one agent (mock-up 27-model-main, 27-model-coding): its aliases, the models it can use
 * (a few, then a count), then "Back to its own" and the note. The header is the first item's. Empty until the reads
 * have answered, so the palette opens on real rows.
 */
export function modelMenuItems(choices: ModelChoices, name: string): SlashCommand[] {
  if (!choices.ready) return []
  const own = ownModelText(choices)
  const header = `Model for ${name} in this chat · its own is ${own}`
  const note = choices.coding
    ? `Only the models ${name}’s program (${choices.program}) takes. Switching program in a chat isn’t offered.`
    : `Only models ${name}’s providers offer are listed. Other chats keep its own model.`
  const row = (group: string, choice: { value: string; detail: string }): SlashCommand => ({
    name: 'model',
    usage: `/model ${choice.value}`,
    insert: `/model ${choice.value}`,
    key: `model-${group}-${choice.value}`,
    description: choice.detail,
    group,
    note,
  })
  const shown = choices.models.slice(0, PALETTE_MODELS)
  const more = choices.models.length - shown.length
  const modelGroup = choices.coding ? choices.programGroup : 'MODELS IT CAN USE · type to search'
  const items: SlashCommand[] = [
    ...choices.aliases.map((alias) => row('ALIASES', alias)),
    ...shown.map((model, index) => ({
      ...row(modelGroup, model),
      ...(more > 0 && index === shown.length - 1
        ? { after: `+ ${more} more: keep typing to narrow` }
        : {}),
    })),
    {
      name: 'model',
      usage: '/model default',
      insert: '/model default',
      key: 'model-default',
      description: `Back to ${name}’s own (${own})`,
      group: '',
      note,
    },
  ]
  const first = items[0]
  if (first) first.header = header
  return items
}
