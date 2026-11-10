import type { AgentSummary } from '@score/contract'
import { useQuery } from '@tanstack/react-query'
import { useMemo, useState, type Dispatch, type SetStateAction } from 'react'
import { apiFetch } from '../../data/api.ts'
import {
  insertMention,
  mentionAt,
  parseCommands,
  slashQuery,
  type SlashCommand,
} from './composer-model.ts'
import type { TopicCommands } from './composer-types.ts'
import { LOCAL_COMMAND_MENU } from './context-meter.ts'

const ORCHESTRATE_MENU_ITEM: SlashCommand = {
  name: 'orchestrate',
  usage: '/orchestrate <goal>',
  description: 'Start an orchestration for a goal.',
}

export function useComposerMenu({
  text,
  caret,
  offered,
  orchestrate,
  topicCommands,
  addressee,
  ids,
  textarea,
  setText,
  setCaret,
}: {
  text: string
  caret: number
  offered: AgentSummary[]
  /** The one agent a bare command acts on (`/effort`'s levels depend on it); null when it isn't one. */
  addressee: string | null
  orchestrate?: (goal: string) => void
  topicCommands?: TopicCommands
  ids: string
  textarea: { current: HTMLTextAreaElement | null }
  setText: Dispatch<SetStateAction<string>>
  setCaret: Dispatch<SetStateAction<number>>
}) {
  const [active, setActive] = useState(0)
  const [closed, setClosed] = useState(false)
  const commands = useQuery({
    queryKey: ['chat', 'commands'],
    queryFn: async () => parseCommands(await apiFetch('commands')),
    staleTime: Infinity,
  })
  const slash = slashQuery(text)
  const mention = slash === null ? mentionAt(text, caret) : null
  const slashItems: SlashCommand[] = useMemo(
    () =>
      slash === null
        ? []
        : [
            ...(commands.data ?? []),
            ...LOCAL_COMMAND_MENU.filter(
              (local) => !commands.data?.some((item) => item.name === local.name),
            ),
            ...(topicCommands?.items ?? []).filter(
              (extra) => !commands.data?.some((item) => item.name === extra.name),
            ),
            ...(topicCommands?.menuFor?.(addressee) ?? []),
            ...(orchestrate ? [ORCHESTRATE_MENU_ITEM] : []),
          ].filter((item) => item.name.startsWith(slash)),
    [slash, commands.data, orchestrate, topicCommands, addressee],
  )
  const mentionItems = useMemo(() => {
    if (!mention) return []
    const query = mention.query.toLowerCase()
    return offered.filter(
      (agent) =>
        agent.id.toLowerCase().startsWith(query) || agent.name.toLowerCase().startsWith(query),
    )
  }, [mention, offered])
  const menu: 'slash' | 'mention' | null = closed
    ? null
    : slashItems.length
      ? 'slash'
      : mentionItems.length
        ? 'mention'
        : null
  const count = menu === 'slash' ? slashItems.length : mentionItems.length
  const index = Math.min(active, Math.max(count - 1, 0))
  const optionId = (position: number) => `${ids}-option-${position}`

  function edit(value: string, position: number) {
    setText(value)
    setCaret(position)
    setActive(0)
    setClosed(false)
  }
  // After a pick the caret goes to the end of what was inserted, once React has written the value. A frame later the
  // person may already have typed on (the next "@" of a fast typist): then the text differs and the caret is theirs.
  function restoreCaret(area: HTMLTextAreaElement | null, expected: string, position: number) {
    requestAnimationFrame(() => {
      if (area && area.value === expected) area.setSelectionRange(position, position)
    })
  }
  function select(position: number) {
    const area = textarea.current
    if (menu === 'slash') {
      const command = slashItems[position]
      if (!command) return
      const next = `${command.insert ?? `/${command.name}`} `
      edit(next, next.length)
      restoreCaret(area, next, next.length)
    } else if (menu === 'mention' && mention) {
      const agent = mentionItems[position]
      if (!agent) return
      const next = insertMention(text, caret, mention.start, agent.id)
      edit(next.text, next.caret)
      restoreCaret(area, next.text, next.caret)
    }
  }

  return {
    commands,
    slashItems,
    mentionItems,
    menu,
    count,
    index,
    optionId,
    edit,
    select,
    setActive,
    setClosed,
  }
}
